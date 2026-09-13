mod db;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let db_file = dir.join("tasks.db");
            let conn = db::init_db(&db_file);
            app.manage(db::AppState {
                conn: std::sync::Mutex::new(conn),
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::init())
        .invoke_handler(tauri::generate_handler![
            get_folders,
            create_folder,
            rename_folder,
            delete_folder,
            get_tasks,
            create_task,
            update_task_content,
            update_task_position,
            toggle_task,
            reorder_tasks,
            delete_task,
            storage_info,
            open_data_dir,
            get_calendar_tasks,
            set_calendar_date,
            get_task_history,
            save_task_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

type DbState<'a> = tauri::State<'a, db::AppState>;

#[tauri::command]
fn storage_info(app: tauri::AppHandle) -> String {
    let dir = app.path().app_data_dir().map(|d| d.display().to_string()).unwrap_or_default();
    let state = app.state::<db::AppState>();
    let conn = state.conn.lock();
    if let Ok(conn) = conn {
        let folders: i64 = conn
            .query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))
            .unwrap_or(0);
        let tasks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
            .unwrap_or(0);
        format!("db_dir={dir} | folders={folders} | tasks={tasks}")
    } else {
        format!("db_dir={dir} | 数据库锁定")
    }
}

/// 用系统文件管理器打开数据目录，便于用户手动备份/迁移 SQLite 数据库
#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    use std::process::Command;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let path = dir.to_string_lossy().to_string();
    let result = if cfg!(windows) {
        Command::new("explorer.exe").arg(&path).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&path).spawn()
    } else {
        Command::new("xdg-open").arg(&path).spawn()
    };
    result.map_err(|e| format!("无法打开数据目录: {e}"))?;
    Ok(path)
}

#[tauri::command]
fn get_folders(state: DbState) -> Result<Vec<db::Folder>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_folders(&conn)
}

#[tauri::command]
fn create_folder(state: DbState, name: String) -> Result<db::Folder, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::create_folder(&conn, &name)
}

#[tauri::command]
fn rename_folder(state: DbState, id: i64, name: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::rename_folder(&conn, id, &name)
}

#[tauri::command]
fn delete_folder(state: DbState, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::delete_folder(&conn, id)
}

#[tauri::command]
fn get_tasks(state: DbState, folder_id: i64) -> Result<Vec<db::Task>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_tasks(&conn, folder_id)
}

#[tauri::command]
fn create_task(
    state: DbState,
    folder_id: i64,
    content: String,
    position_x: Option<f64>,
    position_y: Option<f64>,
) -> Result<db::Task, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::create_task(&conn, folder_id, &content, position_x.unwrap_or(0.0), position_y.unwrap_or(0.0))
}

#[tauri::command]
fn update_task_position(state: DbState, id: i64, x: f64, y: f64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::update_task_position(&conn, id, x, y)
}

#[tauri::command]
fn update_task_content(state: DbState, id: i64, content: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::update_task_content(&conn, id, &content)
}

#[tauri::command]
fn toggle_task(state: DbState, id: i64, is_completed: bool) -> Result<db::Task, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::toggle_task(&conn, id, is_completed)
}

#[tauri::command]
fn reorder_tasks(state: DbState, ids: Vec<i64>) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::reorder_tasks(&mut conn, ids)
}

#[tauri::command]
fn delete_task(state: DbState, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::delete_task(&conn, id)
}

#[tauri::command]
fn get_calendar_tasks(state: DbState) -> Result<Vec<db::Task>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_calendar_tasks(&conn)
}

#[tauri::command]
fn set_calendar_date(state: DbState, id: i64, date_str: Option<String>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::set_calendar_date(&conn, id, date_str.as_deref())
}

#[tauri::command]
fn get_task_history(state: DbState, task_id: i64) -> Result<Vec<db::TaskHistory>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_task_history(&conn, task_id)
}

#[tauri::command]
fn save_task_history(
    state: DbState,
    task_id: i64,
    old_content: String,
    new_content: String,
    change_type: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::save_task_history(&conn, task_id, &old_content, &new_content, &change_type)
}
