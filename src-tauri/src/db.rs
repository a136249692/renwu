use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;

pub struct AppState {
    pub conn: Mutex<Connection>,
}

#[derive(Serialize)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub total: i64,
    pub completed: i64,
}

#[derive(Serialize)]
pub struct Task {
    pub id: i64,
    pub folder_id: i64,
    pub content: String,
    pub is_completed: bool,
    pub created_at: i64,
    pub sort_order: i64,
    pub x: f64,
    pub y: f64,
    pub calendar_date: Option<String>,
}

#[derive(Serialize)]
pub struct TaskHistory {
    pub id: i64,
    pub task_id: i64,
    pub old_content: String,
    pub new_content: String,
    pub change_type: String,
    pub changed_at: i64,
}

pub fn init_db(db_path: &std::path::Path) -> Connection {
    std::fs::create_dir_all(db_path.parent().unwrap_or(std::path::Path::new(".")))
        .expect("Failed to create data dir");
    let conn = Connection::open(db_path).expect("Failed to open database");
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            sort_order INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            is_completed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            sort_order INTEGER DEFAULT 0,
            updated_at INTEGER,
            calendar_date TEXT
        );
        CREATE TABLE IF NOT EXISTS task_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            old_content TEXT NOT NULL,
            new_content TEXT NOT NULL,
            change_type TEXT NOT NULL,
            changed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_folder ON tasks(folder_id, is_completed, sort_order);",
    )
    .expect("Failed to init schema");
    migrate(&conn);
    conn
}

/// Add x/y coordinate columns for the free-canvas layout (idempotent).
fn migrate(conn: &Connection) {
    let has_pos = conn
        .prepare("SELECT x FROM tasks LIMIT 0")
        .map(|_| true)
        .unwrap_or(false);
    if !has_pos {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN x REAL DEFAULT 0;
             ALTER TABLE tasks ADD COLUMN y REAL DEFAULT 0;",
        )
        .expect("Failed to migrate tasks (x/y)");
    }
    let has_cal = conn
        .prepare("SELECT calendar_date FROM tasks LIMIT 0")
        .map(|_| true)
        .unwrap_or(false);
    if !has_cal {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN calendar_date TEXT;",
        )
        .expect("Failed to migrate tasks (calendar_date)");
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            old_content TEXT NOT NULL,
            new_content TEXT NOT NULL,
            change_type TEXT NOT NULL,
            changed_at INTEGER NOT NULL
        );",
    )
    .expect("Failed to create task_history");
}

// ---------- Folders ----------

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, f.created_at,
                    (SELECT COUNT(*) FROM tasks t WHERE t.folder_id = f.id) AS total,
                    (SELECT COUNT(*) FROM tasks t WHERE t.folder_id = f.id AND t.is_completed = 1) AS completed
             FROM folders f ORDER BY f.created_at ASC, f.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let folders = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                total: row.get(3)?,
                completed: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(folders)
}

pub fn create_folder(conn: &Connection, name: &str) -> Result<Folder, String> {
    let name = if name.trim().is_empty() {
        "未命名任务夹".to_string()
    } else {
        name.trim().to_string()
    };
    let now = now_millis();
    conn.execute(
        "INSERT INTO folders (name, created_at) VALUES (?1, ?2)",
        rusqlite::params![name, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Folder {
        id,
        name,
        created_at: now,
        total: 0,
        completed: 0,
    })
}

pub fn rename_folder(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    conn.execute(
        "UPDATE folders SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_folder(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- Tasks ----------

pub fn list_tasks(conn: &Connection, folder_id: i64) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, content, is_completed, created_at, sort_order, x, y, calendar_date
             FROM tasks WHERE folder_id = ?1
             ORDER BY is_completed ASC, sort_order ASC, created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([folder_id], |row| {
            Ok(Task {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                content: row.get(2)?,
                is_completed: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                sort_order: row.get(5)?,
                x: row.get(6)?,
                y: row.get(7)?,
                calendar_date: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tasks)
}

fn next_sort_order(conn: &Connection, folder_id: i64, is_completed: bool) -> Result<i64, String> {
    let v: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tasks WHERE folder_id = ?1 AND is_completed = ?2",
            rusqlite::params![folder_id, is_completed as i64],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(v)
}

pub fn create_task(
    conn: &Connection,
    folder_id: i64,
    content: &str,
    x: f64,
    y: f64,
) -> Result<Task, String> {
    let content = if content.trim().is_empty() {
        "未命名任务".to_string()
    } else {
        content.trim().to_string()
    };
    let now = now_millis();
    let sort_order = next_sort_order(conn, folder_id, false)?;
    conn.execute(
        "INSERT INTO tasks (folder_id, content, is_completed, created_at, sort_order, updated_at, x, y)
         VALUES (?1, ?2, 0, ?3, ?4, ?3, ?5, ?6)",
        rusqlite::params![folder_id, content, now, sort_order, x, y],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Task {
        id,
        folder_id,
        content,
        is_completed: false,
        created_at: now,
        sort_order,
        x,
        y,
        calendar_date: None,
    })
}

pub fn update_task_content(conn: &Connection, id: i64, content: &str) -> Result<(), String> {
    let content = content.trim();
    conn.execute(
        "UPDATE tasks SET content = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![content, now_millis(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn toggle_task(conn: &Connection, id: i64, is_completed: bool) -> Result<Task, String> {
    let folder_id: i64 = conn
        .query_row(
            "SELECT folder_id FROM tasks WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let sort_order = next_sort_order(conn, folder_id, is_completed)?;
    conn.execute(
        "UPDATE tasks SET is_completed = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![is_completed as i64, sort_order, now_millis(), id],
    )
    .map_err(|e| e.to_string())?;
    let content: String = conn
        .query_row(
            "SELECT content FROM tasks WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let created_at: i64 = conn
        .query_row(
            "SELECT created_at FROM tasks WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let (x, y): (f64, f64) = conn
        .query_row(
            "SELECT x, y FROM tasks WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let calendar_date: Option<String> = conn
        .query_row(
            "SELECT calendar_date FROM tasks WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(Task {
        id,
        folder_id,
        content,
        is_completed,
        created_at,
        sort_order,
        x,
        y,
        calendar_date,
    })
}

pub fn update_task_position(conn: &Connection, id: i64, x: f64, y: f64) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET x = ?1, y = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![x, y, now_millis(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Reorder tasks within one completion group given an ordered list of ids.
pub fn reorder_tasks(conn: &mut Connection, ids: Vec<i64>) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    for (idx, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE tasks SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![(idx as i64) + 1, now_millis(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_task(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM tasks WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取所有设置了 calendar_date 的任务
pub fn list_calendar_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, content, is_completed, created_at, sort_order, x, y, calendar_date
             FROM tasks WHERE calendar_date IS NOT NULL
             ORDER BY calendar_date ASC, created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let tasks = stmt
        .query_map([], |row| {
            Ok(Task {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                content: row.get(2)?,
                is_completed: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                sort_order: row.get(5)?,
                x: row.get(6)?,
                y: row.get(7)?,
                calendar_date: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tasks)
}

/// 设置任务的日历日期
pub fn set_calendar_date(conn: &Connection, id: i64, date_str: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET calendar_date = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![date_str, now_millis(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存任务变更历史
pub fn save_task_history(
    conn: &Connection,
    task_id: i64,
    old_content: &str,
    new_content: &str,
    change_type: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO task_history (task_id, old_content, new_content, change_type, changed_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![task_id, old_content, new_content, change_type, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取任务的变更历史
pub fn list_task_history(conn: &Connection, task_id: i64) -> Result<Vec<TaskHistory>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, old_content, new_content, change_type, changed_at
             FROM task_history WHERE task_id = ?1
             ORDER BY changed_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let history = stmt
        .query_map([task_id], |row| {
            Ok(TaskHistory {
                id: row.get(0)?,
                task_id: row.get(1)?,
                old_content: row.get(2)?,
                new_content: row.get(3)?,
                change_type: row.get(4)?,
                changed_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(history)
}

pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}