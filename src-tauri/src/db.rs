use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
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

/// 思维导图：一个导图（左侧可命名/切换，直接在 SQLite 建表）
#[derive(Serialize)]
pub struct Mindmap {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub pan_x: f64,
    pub pan_y: f64,
    pub zoom: f64,
}

/// 思维导图内的节点（内容块）
#[derive(Serialize)]
pub struct MindmapNode {
    pub id: i64,
    pub map_id: i64,
    pub content: String,
    pub x: f64,
    pub y: f64,
    pub created_at: i64,
}

/// 思维导图内的连线（节点间关系）
#[derive(Serialize)]
pub struct MindmapEdge {
    pub id: i64,
    pub map_id: i64,
    pub from_id: i64,
    pub to_id: i64,
}

/// 图片夹：一个独立的图片墙画布（左侧可命名/切换，图片文件按夹归档到本地）
#[derive(Serialize)]
pub struct ImageFolder {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub total: i64,
    pub pan_x: f64,
    pub pan_y: f64,
    pub zoom: f64,
}

/// 图片墙中的一张图片。file_path 存的是相对 images/ 根目录的路径
/// （形如 <folder_id>/<uuid>.png），便于整个目录迁移；读取时再拼接绝对路径。
#[derive(Serialize)]
pub struct ImageItem {
    pub id: i64,
    pub folder_id: i64,
    pub file_name: String,
    pub file_path: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub created_at: i64,
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
        CREATE INDEX IF NOT EXISTS idx_tasks_folder ON tasks(folder_id, is_completed, sort_order);
        CREATE TABLE IF NOT EXISTS mindmaps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            pan_x REAL DEFAULT 40,
            pan_y REAL DEFAULT 40,
            zoom REAL DEFAULT 1.0
        );
        CREATE TABLE IF NOT EXISTS mindmap_nodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            map_id INTEGER NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            x REAL DEFAULT 0,
            y REAL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mindmap_edges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            map_id INTEGER NOT NULL REFERENCES mindmaps(id) ON DELETE CASCADE,
            from_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mm_nodes_map ON mindmap_nodes(map_id);
        CREATE TABLE IF NOT EXISTS image_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            pan_x REAL DEFAULT 40,
            pan_y REAL DEFAULT 40,
            zoom REAL DEFAULT 1.0
        );
        CREATE TABLE IF NOT EXISTS image_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id INTEGER NOT NULL REFERENCES image_folders(id) ON DELETE CASCADE,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            title TEXT DEFAULT '',
            x REAL DEFAULT 0,
            y REAL DEFAULT 0,
            width REAL DEFAULT 0,
            height REAL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_image_items_folder ON image_items(folder_id);",
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

// ---------- 思维导图 ----------

pub fn list_mindmaps(conn: &Connection) -> Result<Vec<Mindmap>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, created_at, pan_x, pan_y, zoom
             FROM mindmaps ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let maps = stmt
        .query_map([], |row| {
            Ok(Mindmap {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                pan_x: row.get(3)?,
                pan_y: row.get(4)?,
                zoom: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(maps)
}

pub fn create_mindmap(conn: &Connection, name: &str) -> Result<Mindmap, String> {
    let name = if name.trim().is_empty() {
        "未命名思维导图".to_string()
    } else {
        name.trim().to_string()
    };
    let now = now_millis();
    conn.execute(
        "INSERT INTO mindmaps (name, created_at) VALUES (?1, ?2)",
        rusqlite::params![name, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Mindmap {
        id,
        name,
        created_at: now,
        pan_x: 40.0,
        pan_y: 40.0,
        zoom: 1.0,
    })
}

pub fn rename_mindmap(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    conn.execute(
        "UPDATE mindmaps SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_mindmap_view(conn: &Connection, id: i64, pan_x: f64, pan_y: f64, zoom: f64) -> Result<(), String> {
    conn.execute(
        "UPDATE mindmaps SET pan_x = ?1, pan_y = ?2, zoom = ?3 WHERE id = ?4",
        rusqlite::params![pan_x, pan_y, zoom, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_mindmap(conn: &Connection, id: i64) -> Result<(), String> {
    // 先清理该导图的连线与节点，避免遗留孤儿数据
    conn.execute("DELETE FROM mindmap_edges WHERE map_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM mindmap_nodes WHERE map_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM mindmaps WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 思维导图节点 ----------

pub fn list_mindmap_nodes(conn: &Connection, map_id: i64) -> Result<Vec<MindmapNode>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, map_id, content, x, y, created_at
             FROM mindmap_nodes WHERE map_id = ?1 ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let nodes = stmt
        .query_map([map_id], |row| {
            Ok(MindmapNode {
                id: row.get(0)?,
                map_id: row.get(1)?,
                content: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(nodes)
}

pub fn create_mindmap_node(
    conn: &Connection,
    map_id: i64,
    content: &str,
    x: f64,
    y: f64,
) -> Result<MindmapNode, String> {
    let content = content.to_string();
    let now = now_millis();
    conn.execute(
        "INSERT INTO mindmap_nodes (map_id, content, x, y, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![map_id, content, x, y, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(MindmapNode {
        id,
        map_id,
        content,
        x,
        y,
        created_at: now,
    })
}

pub fn update_mindmap_node_content(conn: &Connection, id: i64, content: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE mindmap_nodes SET content = ?1 WHERE id = ?2",
        rusqlite::params![content, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_mindmap_node_position(conn: &Connection, id: i64, x: f64, y: f64) -> Result<(), String> {
    conn.execute(
        "UPDATE mindmap_nodes SET x = ?1, y = ?2 WHERE id = ?3",
        rusqlite::params![x, y, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_mindmap_node(conn: &Connection, id: i64) -> Result<(), String> {
    // 同时删掉与该节点关联的连线
    conn.execute("DELETE FROM mindmap_edges WHERE from_id = ?1 OR to_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM mindmap_nodes WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 思维导图连线 ----------

pub fn list_mindmap_edges(conn: &Connection, map_id: i64) -> Result<Vec<MindmapEdge>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, map_id, from_id, to_id
             FROM mindmap_edges WHERE map_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let edges = stmt
        .query_map([map_id], |row| {
            Ok(MindmapEdge {
                id: row.get(0)?,
                map_id: row.get(1)?,
                from_id: row.get(2)?,
                to_id: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(edges)
}

pub fn add_mindmap_edge(conn: &Connection, map_id: i64, from_id: i64, to_id: i64) -> Result<MindmapEdge, String> {
    // 不允许自连
    if from_id == to_id {
        return Err("不能连接到自身".into());
    }
    // 避免重复连线
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mindmap_edges WHERE map_id = ?1 AND from_id = ?2 AND to_id = ?3",
            rusqlite::params![map_id, from_id, to_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err("已存在该连线".into());
    }
    conn.execute(
        "INSERT INTO mindmap_edges (map_id, from_id, to_id) VALUES (?1, ?2, ?3)",
        rusqlite::params![map_id, from_id, to_id],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(MindmapEdge {
        id,
        map_id,
        from_id,
        to_id,
    })
}

pub fn delete_mindmap_edge(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM mindmap_edges WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- 图片墙 ----------

/// 图片文件统一归档在 <app_data>/images/<folder_id>/ 下，与数据库同级，
/// 便于「用系统文件管理器打开数据目录」时一并备份/迁移。
pub fn images_root(data_dir: &Path) -> PathBuf {
    data_dir.join("images")
}

pub fn folder_image_dir(data_dir: &Path, folder_id: i64) -> PathBuf {
    images_root(data_dir).join(folder_id.to_string())
}

pub fn list_image_folders(conn: &Connection) -> Result<Vec<ImageFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.id, f.name, f.created_at, f.pan_x, f.pan_y, f.zoom,
                    (SELECT COUNT(*) FROM image_items i WHERE i.folder_id = f.id) AS total
             FROM image_folders f ORDER BY f.created_at ASC, f.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let folders = stmt
        .query_map([], |row| {
            Ok(ImageFolder {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                pan_x: row.get(3)?,
                pan_y: row.get(4)?,
                zoom: row.get(5)?,
                total: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(folders)
}

pub fn create_image_folder(conn: &Connection, name: &str) -> Result<ImageFolder, String> {
    let name = if name.trim().is_empty() {
        "未命名图片夹".to_string()
    } else {
        name.trim().to_string()
    };
    let now = now_millis();
    conn.execute(
        "INSERT INTO image_folders (name, created_at) VALUES (?1, ?2)",
        rusqlite::params![name, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(ImageFolder {
        id,
        name,
        created_at: now,
        pan_x: 40.0,
        pan_y: 40.0,
        zoom: 1.0,
        total: 0,
    })
}

pub fn rename_image_folder(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    conn.execute(
        "UPDATE image_folders SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_image_folder_view(conn: &Connection, id: i64, pan_x: f64, pan_y: f64, zoom: f64) -> Result<(), String> {
    conn.execute(
        "UPDATE image_folders SET pan_x = ?1, pan_y = ?2, zoom = ?3 WHERE id = ?4",
        rusqlite::params![pan_x, pan_y, zoom, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_image_folder(conn: &Connection, id: i64) -> Result<(), String> {
    // image_items 依赖 ON DELETE CASCADE 自动清理数据库记录；
    // 物理图片文件由调用方（lib.rs 命令）删除对应目录。
    conn.execute("DELETE FROM image_folders WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 保存一张上传的图片：先落盘到 <app_data>/images/<folder_id>/，再写数据库记录。
/// 落盘失败时不会留下孤儿数据库行；写库失败时会删掉刚写入的文件。
pub fn save_image(
    conn: &Connection,
    data_dir: &Path,
    folder_id: i64,
    file_name: &str,
    title: &str,
    data: &[u8],
) -> Result<ImageItem, String> {
    if data.is_empty() {
        return Err("图片数据为空".into());
    }
    let rel = format!("{}/{}", folder_id, file_name);
    let abs = images_root(data_dir).join(&rel);
    std::fs::create_dir_all(abs.parent().ok_or("图片目录异常")?)
        .map_err(|e| format!("无法创建图片目录: {e}"))?;
    std::fs::write(&abs, data).map_err(|e| format!("无法保存图片: {e}"))?;

    let now = now_millis();
    let title = title.trim().to_string();
    let result = conn
        .execute(
            "INSERT INTO image_items (folder_id, file_name, file_path, title, x, y, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, 0, 0, 0, 0, ?5)",
            rusqlite::params![folder_id, file_name, rel, title, now],
        )
        .map_err(|e| e.to_string());
    match result {
        Ok(_) => Ok(ImageItem {
            id: conn.last_insert_rowid(),
            folder_id,
            file_name: file_name.to_string(),
            file_path: rel,
            title,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            created_at: now,
        }),
        Err(e) => {
            // 写库失败，回收刚落盘的文件，避免出现无记录的文件
            let _ = std::fs::remove_file(&abs);
            Err(e)
        }
    }
}

pub fn list_image_items(conn: &Connection, folder_id: i64) -> Result<Vec<ImageItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, folder_id, file_name, file_path, title, x, y, width, height, created_at
             FROM image_items WHERE folder_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map([folder_id], |row| {
            Ok(ImageItem {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                file_name: row.get(2)?,
                file_path: row.get(3)?,
                title: row.get(4)?,
                x: row.get(5)?,
                y: row.get(6)?,
                width: row.get(7)?,
                height: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(items)
}

pub fn update_image_item(
    conn: &Connection,
    id: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    title: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE image_items SET x = ?1, y = ?2, width = ?3, height = ?4, title = ?5 WHERE id = ?6",
        rusqlite::params![x, y, width, height, title, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_image_item(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM image_items WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 读取单张图片的原始字节（按记录里的相对路径定位）。
pub fn read_image_file(data_dir: &Path, folder_id: i64, file_path: &str) -> Result<Vec<u8>, String> {
    let abs = images_root(data_dir).join(file_path);
    // 目录穿越防护：相对路径必须落在该夹的子目录下
    let abs_canonical = abs.canonicalize().map_err(|e| format!("图片不存在: {e}"))?;
    let base = folder_image_dir(data_dir, folder_id)
        .canonicalize()
        .map_err(|e| format!("图片目录不存在: {e}"))?;
    if !abs_canonical.starts_with(&base) {
        return Err("非法的图片路径".into());
    }
    std::fs::read(&abs_canonical).map_err(|e| format!("无法读取图片: {e}"))
}

pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}