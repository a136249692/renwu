mod backup;
mod db;

use std::collections::HashMap;
use std::path::Path;
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            save_task_history,
            list_mindmaps,
            create_mindmap,
            rename_mindmap,
            update_mindmap_view,
            delete_mindmap,
            list_mindmap_nodes,
            create_mindmap_node,
            update_mindmap_node_content,
            update_mindmap_node_position,
            delete_mindmap_node,
            list_mindmap_edges,
            add_mindmap_edge,
            delete_mindmap_edge,
            list_image_folders,
            create_image_folder,
            rename_image_folder,
            update_image_folder_view,
            delete_image_folder,
            list_image_items,
            save_image,
            update_image_item,
            delete_image_item,
            read_image_file,
            create_backup,
            restore_backup
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

#[tauri::command]
fn list_mindmaps(state: DbState) -> Result<Vec<db::Mindmap>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_mindmaps(&conn)
}

#[tauri::command]
fn create_mindmap(state: DbState, name: String) -> Result<db::Mindmap, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::create_mindmap(&conn, &name)
}

#[tauri::command]
fn rename_mindmap(state: DbState, id: i64, name: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::rename_mindmap(&conn, id, &name)
}

#[tauri::command]
fn update_mindmap_view(state: DbState, id: i64, pan_x: f64, pan_y: f64, zoom: f64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::update_mindmap_view(&conn, id, pan_x, pan_y, zoom)
}

#[tauri::command]
fn delete_mindmap(state: DbState, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::delete_mindmap(&conn, id)
}

#[tauri::command]
fn list_mindmap_nodes(state: DbState, map_id: i64) -> Result<Vec<db::MindmapNode>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_mindmap_nodes(&conn, map_id)
}

#[tauri::command]
fn create_mindmap_node(
    state: DbState,
    map_id: i64,
    content: String,
    x: f64,
    y: f64,
) -> Result<db::MindmapNode, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::create_mindmap_node(&conn, map_id, &content, x, y)
}

#[tauri::command]
fn update_mindmap_node_content(state: DbState, id: i64, content: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::update_mindmap_node_content(&conn, id, &content)
}

#[tauri::command]
fn update_mindmap_node_position(state: DbState, id: i64, x: f64, y: f64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::update_mindmap_node_position(&conn, id, x, y)
}

#[tauri::command]
fn delete_mindmap_node(state: DbState, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::delete_mindmap_node(&conn, id)
}

#[tauri::command]
fn list_mindmap_edges(state: DbState, map_id: i64) -> Result<Vec<db::MindmapEdge>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_mindmap_edges(&conn, map_id)
}

#[tauri::command]
fn add_mindmap_edge(state: DbState, map_id: i64, from_id: i64, to_id: i64) -> Result<db::MindmapEdge, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::add_mindmap_edge(&conn, map_id, from_id, to_id)
}

#[tauri::command]
fn delete_mindmap_edge(state: DbState, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::delete_mindmap_edge(&conn, id)
}

/// 取应用数据目录；图片文件与数据库都放在这里，便于整目录备份。
fn app_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
fn list_image_folders(state: DbState) -> Result<Vec<db::ImageFolder>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_image_folders(&conn)
}

#[tauri::command]
fn create_image_folder(state: DbState, name: String) -> Result<db::ImageFolder, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::create_image_folder(&conn, &name)
}

#[tauri::command]
fn rename_image_folder(state: DbState, id: i64, name: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::rename_image_folder(&conn, id, &name)
}

#[tauri::command]
fn update_image_folder_view(state: DbState, id: i64, pan_x: f64, pan_y: f64, zoom: f64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::update_image_folder_view(&conn, id, pan_x, pan_y, zoom)
}

#[tauri::command]
fn delete_image_folder(app: tauri::AppHandle, state: DbState, id: i64) -> Result<(), String> {
    // 先删数据库记录（image_items 级联删除），再删该夹的图片目录。
    // 顺序反过来会有「文件已删、记录还在」的窗口期，点开放裂图标会报错。
    {
        let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
        db::delete_image_folder(&conn, id)?;
    }
    let dir = app_data_dir(&app)?;
    let img_dir = db::folder_image_dir(&dir, id);
    if img_dir.exists() {
        std::fs::remove_dir_all(&img_dir).map_err(|e| format!("无法删除图片目录: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn list_image_items(state: DbState, folder_id: i64) -> Result<Vec<db::ImageItem>, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::list_image_items(&conn, folder_id)
}

/// 保存上传的图片。data 为原始图片字节（前端 File → ArrayBuffer → invoke）。
/// Tauri 参数名按 snake_case 绑定，JS 侧传 folderId 会自动映射到 folder_id。
#[tauri::command]
fn save_image(
    app: tauri::AppHandle,
    state: DbState,
    folder_id: i64,
    file_name: String,
    title: String,
    data: Vec<u8>,
) -> Result<db::ImageItem, String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    let dir = app_data_dir(&app)?;
    db::save_image(&conn, &dir, folder_id, &file_name, &title, &data)
}

#[tauri::command]
fn update_image_item(
    state: DbState,
    id: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    title: String,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    db::update_image_item(&conn, id, x, y, width, height, &title)
}

#[tauri::command]
fn delete_image_item(app: tauri::AppHandle, state: DbState, id: i64) -> Result<(), String> {
    // 取出该图片的相对路径，用于删除物理文件
    let rel = {
        let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
        conn.query_row(
            "SELECT folder_id, file_path FROM image_items WHERE id = ?1",
            rusqlite::params![id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .map_err(|_| "图片不存在".to_string())?
    };
    {
        let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
        db::delete_image_item(&conn, id)?;
    }
    let dir = app_data_dir(&app)?;
    let abs = db::images_root(&dir).join(&rel.1);
    let _ = std::fs::remove_file(&abs);
    Ok(())
}

/// 读取单张图片的原始字节。前端用 blob URL 直接绘制，避免每张图片都常驻内存 base64。
#[tauri::command]
fn read_image_file(app: tauri::AppHandle, folder_id: i64, file_path: String) -> Result<Vec<u8>, String> {
    let dir = app_data_dir(&app)?;
    db::read_image_file(&dir, folder_id, &file_path)
}

/// 全量备份：数据库（含 WAL 折叠快照）+ images 图片目录 + 前端 localStorage 配置，
/// 全部打包为 zip 写入 dest_path（用户通过保存对话框选择的位置）。
#[tauri::command]
fn create_backup(
    app: tauri::AppHandle,
    state: DbState,
    dest_path: String,
    storage: Option<HashMap<String, String>>,
) -> Result<backup::BackupReport, String> {
    let data_dir = app_data_dir(&app)?;
    let config_dir = data_dir.join("config");
    let conn = state.conn.lock().map_err(|_| "数据库忙".to_string())?;
    let storage = storage.unwrap_or_default();
    backup::create_backup(&conn, &data_dir, Some(&config_dir), Path::new(&dest_path), storage)
}

/// 从备份 zip 还原数据库、图片与配置。返回 storage 映射（前端 localStorage 快照），
/// 前端据此写回后再调用重启，App 重新加载新数据库与配置。
#[tauri::command]
fn restore_backup(
    app: tauri::AppHandle,
    src_path: String,
) -> Result<backup::RestoreReport, String> {
    use std::fs;
    let data_dir = app_data_dir(&app)?;
    let config_dir = data_dir.join("config");
    let db_path = data_dir.join("tasks.db");
    let bytes = fs::read(&src_path).map_err(|e| format!("读取备份失败: {e}"))?;
    backup::restore_from_zip(&bytes, &data_dir, Some(&config_dir), &db_path)
}
