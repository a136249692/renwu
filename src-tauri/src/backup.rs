use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct BackupReport {
    pub path: String,
    pub size: u64,
    pub db_size: u64,
    pub image_count: u64,
    pub image_bytes: u64,
    pub storage_keys: usize,
}

#[derive(Serialize)]
pub struct RestoreReport {
    pub restored: bool,
    pub db_size: u64,
    pub image_count: u64,
    pub storage_keys: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<HashMap<String, String>>,
    pub storage_path: String,
}

const DB_REL_IN_ZIP: &str = "backup/db/tasks.db";
const DB_REL_LOCAL: &str = "db/tasks.db";
const IMAGES_DIR: &str = "images";
const IMG_PREFIX: &str = "backup/images/";
const CONFIG_SUBDIR: &str = "config";
const STORAGE_FILE: &str = "storage.json";
const CFG_PREFIX: &str = "backup/config/";
const DB_FILE: &str = "tasks.db";
const ZIP_MAGIC: &[u8] = b"PK\x03\x04";

/// 从 app_data_dir 生成 zip 备份。DB 先执行 WAL checkpoint，再作为快照打包；
/// images 目录递归打包；config/storage.json 是前端 localStorage 的序列化快照。
pub fn create_backup(
    conn: &Connection,
    data_dir: &Path,
    config_dir: Option<&Path>,
    out_path: &Path,
    storage: HashMap<String, String>,
) -> Result<BackupReport, String> {
    let mut writer = fs::File::create(out_path).map_err(|e| format!("无法创建备份文件: {e}"))?;
    let mut archive = zip::ZipWriter::new(&mut writer);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1) DB 快照：checkpoint WAL 保证主库文件包含全部已提交数据
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .map_err(|e| format!("数据库快照失败: {e}"))?;
    let db_path_src = data_dir.join(DB_FILE);
    let db_data = fs::read(&db_path_src).map_err(|e| format!("读取数据库失败: {e}"))?;
    let db_size = db_data.len() as u64;
    archive
        .start_file(DB_REL_IN_ZIP, opts)
        .map_err(|e| format!("写入 zip 失败: {e}"))?;
    archive.write_all(&db_data).map_err(|e| format!("写入 zip 失败: {e}"))?;

    // 2) images 目录递归
    let img_root = data_dir.join(IMAGES_DIR);
    let mut image_count = 0u64;
    let mut image_bytes = 0u64;
    if img_root.exists() {
        for file in collect_files(&img_root)? {
            let rel = file
                .strip_prefix(&img_root)
                .map_err(|e| format!("路径异常: {e}"))?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let entry = format!("{IMG_PREFIX}{rel_str}");
            let data = fs::read(&file).map_err(|e| format!("读取图片失败: {e}"))?;
            archive
                .start_file(&entry, opts)
                .map_err(|e| format!("写入 zip 失败: {e}"))?;
            archive.write_all(&data).map_err(|e| format!("写入 zip 失败: {e}"))?;
            image_count += 1;
            image_bytes += data.len() as u64;
        }
    }

    // 3) config/storage.json
    let storage_json = serde_json::to_vec_pretty(&storage).map_err(|e| e.to_string())?;
    let storage_entry = format!("{CFG_PREFIX}{STORAGE_FILE}");
    archive
        .start_file(&storage_entry, opts)
        .map_err(|e| format!("写入 zip 失败: {e}"))?;
    archive.write_all(&storage_json).map_err(|e| format!("写入 zip 失败: {e}"))?;

    archive
        .finish()
        .map_err(|e| format!("压缩失败: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("刷写失败: {e}"))?;

    if let Some(cfg) = config_dir {
        let _ = fs::create_dir_all(cfg);
        let _ = fs::write(cfg.join(STORAGE_FILE), &storage_json);
    }

    let size = fs::metadata(out_path).map(|m| m.len()).unwrap_or(0);
    Ok(BackupReport {
        path: out_path.display().to_string(),
        size,
        db_size,
        image_count,
        image_bytes,
        storage_keys: storage.len(),
    })
}

/// 从 zip 字节还原。解压到临时目录，再把 db / images / config 覆盖回原位置。
/// 调用方需重启 App 才能加载新数据库与配置。
pub fn restore_from_zip(
    zip_bytes: &[u8],
    data_dir: &Path,
    config_dir: Option<&Path>,
    db_path: &Path,
) -> Result<RestoreReport, String> {
    if zip_bytes.len() < 4 || !zip_bytes.starts_with(ZIP_MAGIC) {
        return Err("不是有效的备份文件（不是 zip 格式）".into());
    }

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| format!("读取备份失败: {e}"))?;

    let tmp_out = data_dir.join(format!(".restore-{}", chrono_now_millis()));
    let _ = fs::remove_dir_all(&tmp_out);
    fs::create_dir_all(&tmp_out).map_err(|e| format!("创建临时目录失败: {e}"))?;

    let mut db_restored = false;
    let mut image_count = 0u64;
    let mut storage_map: HashMap<String, String> = HashMap::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取条目失败: {e}"))?;
        let name = entry.name().to_string();
        let rel = strip_prefix(&name);
        if rel.is_none() {
            continue;
        }
        let rel = rel.unwrap();

        if rel.starts_with('/') || rel.contains("..") || rel.is_empty() {
            return Err(format!("备份包含非法路径: {name}"));
        }
        let target = tmp_out.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("创建目录失败: {e}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("解压条目失败: {e}"))?;
        fs::write(&target, &buf).map_err(|e| format!("写入解压文件失败: {e}"))?;

        match rel.as_str() {
            DB_REL_LOCAL => db_restored = true,
            "config/storage.json" => {
                if let Ok(v) = serde_json::from_slice::<HashMap<String, String>>(&buf) {
                    storage_map = v;
                }
            }
            other => {
                if other.starts_with(IMAGES_DIR) {
                    image_count += 1;
                }
            }
        }
    }

    if !db_restored {
        let _ = fs::remove_dir_all(&tmp_out);
        return Err("备份文件中未找到数据库（backup/db/tasks.db）".into());
    }

    // 覆盖 images 目录
    let new_img = tmp_out.join(IMAGES_DIR);
    if new_img.exists() {
        let dest = data_dir.join(IMAGES_DIR);
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| format!("清理旧 images 失败: {e}"))?;
        }
        fs::rename(&new_img, &dest).map_err(|e| format!("恢复 images 失败: {e}"))?;
    }

    // 覆盖数据库：清掉 WAL/SHM 避免与新主库不一致
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建数据目录失败: {e}"))?;
    }
    if let Some(stem) = db_path.file_stem() {
        let stem_str = stem.to_string_lossy();
        let _ = fs::remove_file(db_path.with_file_name(format!("{stem_str}.wal")));
        let _ = fs::remove_file(db_path.with_file_name(format!("{stem_str}.shm")));
    }
    let tmp_db = tmp_out.join(DB_REL_LOCAL);
    fs::copy(&tmp_db, db_path).map_err(|e| format!("恢复数据库失败: {e}"))?;
    let db_size = fs::metadata(db_path).map(|m| m.len()).unwrap_or(0);

    // 覆盖 config/storage.json
    let mut storage_path = String::new();
    if let Some(cfg) = config_dir {
        fs::create_dir_all(cfg).map_err(|e| format!("创建配置目录失败: {e}"))?;
        let src = tmp_out.join(CONFIG_SUBDIR).join(STORAGE_FILE);
        if src.exists() {
            let dst = cfg.join(STORAGE_FILE);
            fs::copy(&src, &dst).map_err(|e| format!("写入配置失败: {e}"))?;
            storage_path = dst.display().to_string();
        }
    }

    let _ = fs::remove_dir_all(&tmp_out);

    Ok(RestoreReport {
        restored: true,
        db_size,
        image_count,
        storage_keys: storage_map.len(),
        storage: Some(storage_map),
        storage_path,
    })
}

/// 剥掉 zip 内可能的 "backup/" 前缀，返回相对路径；不在允许前缀内的条目返回 None（跳过）。
fn strip_prefix(name: &str) -> Option<String> {
    if let Some(r) = name.strip_prefix("backup/") {
        Some(r.to_string())
    } else if name.starts_with("db/")
        || name.starts_with(IMAGES_DIR)
        || name.starts_with(CONFIG_SUBDIR)
    {
        Some(name.to_string())
    } else {
        None
    }
}

fn chrono_now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn collect_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    let mut stack: VecDeque<PathBuf> = VecDeque::new();
    stack.push_back(root.to_path_buf());
    while let Some(dir) = stack.pop_back() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => return Err(format!("读取目录失败: {e}")),
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => return Err(format!("读取目录条目失败: {e}")),
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(e) => return Err(format!("读取文件类型失败: {e}")),
            };
            if file_type.is_dir() {
                stack.push_back(path);
            } else if file_type.is_file() {
                out.push(path);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn roundtrip_db_images_storage() {
        let tmp = std::env::temp_dir().join(format!("backup-test-{}", chrono_now_millis()));
        let data_dir = tmp.join("data");
        let img_root = data_dir.join(IMAGES_DIR);
        fs::create_dir_all(&img_root).unwrap();
        let db_path = data_dir.join(DB_FILE);
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE t(x INTEGER);
             INSERT INTO t VALUES(42);",
        )
        .unwrap();

        let img = img_root.join("sub.png");
        fs::create_dir_all(img.parent().unwrap()).unwrap();
        fs::write(&img, b"PNGDATA").unwrap();

        let out = tmp.join("backup.zip");
        let mut storage = HashMap::new();
        storage.insert("key".to_string(), "val".to_string());
        storage.insert("num".to_string(), "7".to_string());
        let report = create_backup(&conn, &data_dir, Some(&tmp.join("config")), &out, storage).unwrap();
        assert!(report.image_count >= 1);
        assert_eq!(report.storage_keys, 2);
        // 完成快照后释放连接
        drop(report);
        drop(conn);

        // 还原到全新目录
        let dest = tmp.join("restore");
        fs::create_dir_all(&dest).unwrap();
        let dest_db = dest.join(DB_FILE);
        let bytes = fs::read(&out).unwrap();
        let rep = restore_from_zip(&bytes, &dest, Some(&dest.join("config")), &dest_db).unwrap();
        assert!(rep.restored);
        assert_eq!(rep.storage_keys, 2);
        assert_eq!(rep.storage.as_ref().unwrap().get("key").unwrap(), "val");
        assert!(rep.image_count >= 1);

        // 校验数据库内容
        let c2 = Connection::open(&dest_db).unwrap();
        let x: i64 = c2.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 42);
        assert!(dest.join(IMAGES_DIR).join("sub.png").exists());

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn rejects_non_zip_and_traversal() {
        let tmp = std::env::temp_dir().join(format!("backup-test2-{}", chrono_now_millis()));
        fs::create_dir_all(&tmp).unwrap();
        let r = restore_from_zip(b"notazip", &tmp, None, &tmp.join(DB_FILE));
        assert!(r.is_err());
        fs::remove_dir_all(&tmp).unwrap();
    }
}
