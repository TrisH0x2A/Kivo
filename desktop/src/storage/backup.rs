use std::{collections::BTreeMap, fs, path::{Component, Path, PathBuf}};
use aes_gcm::{aead::{Aead, AeadCore, KeyInit, OsRng}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use super::{durable::{self, SavePlan}, secrets};

const LIMIT: usize = 64_000_000;
const ROUNDS: u32 = 600_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Archive { version: u8, created_at: String, auth_seed: String, files: Vec<BackupFile> }
#[derive(Serialize, Deserialize)]
struct BackupFile { path: String, content: String, sha256: String }
#[derive(Serialize, Deserialize)]
struct Envelope { format: String, version: u8, salt: String, nonce: String, ciphertext: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview { files: Vec<String>, overwrite_count: usize, created_at: String, digest: String, storage_revision: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry { id: String, created_at: String, replaced_files: usize, deleted_items: usize }
#[derive(Deserialize)]
struct RetainedJournal { writes: Vec<RetainedFile>, removals: Vec<PathBuf> }
#[derive(Deserialize)]
struct RetainedFile { path: PathBuf, existed: bool }

fn digest(bytes: &[u8]) -> String { hex::encode(Sha256::digest(bytes)) }

fn validate_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.components().any(|part| match part {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
            let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && matches!(stem.as_bytes()[3], b'1'..=b'9'));
            reserved || name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case(".kivo-recovery") || name.contains([':', '\\', '<', '>', '"', '|', '?', '*']) || name.chars().any(char::is_control) || name.ends_with(['.', ' '])
        }
        _ => true,
    }) { return Err("Backup contains an unsafe path.".into()); }
    Ok(())
}

fn collect_files(directory: &Path, relative: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>, size: &mut usize) -> Result<(), String> {
    if fs::symlink_metadata(directory).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("Linked backup paths are not supported.".into()); }
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if [".git", ".kivo-recovery"].iter().any(|excluded| name.to_string_lossy().eq_ignore_ascii_case(excluded)) || name.to_string_lossy().ends_with(".kivobak") { continue; }
        let path = relative.join(name);
        validate_path(&path)?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() { return Err("Linked backup paths are not supported.".into()); }
        if kind.is_dir() { collect_files(&entry.path(), &path, files, size)?; }
        else if kind.is_file() {
            let length = entry.metadata().map_err(|e| e.to_string())?.len() as usize;
            *size = size.checked_add(length).ok_or("Backup is too large")?;
            if *size > LIMIT || files.len() >= 10_000 { return Err("Backups support up to 64 MB and 10,000 files.".into()); }
            let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
            if bytes.len() != length { return Err("A file changed during backup. Try again.".into()); }
            files.insert(path, bytes);
        }
    }
    Ok(())
}

fn seal(archive: &Archive, password: &str) -> Result<Vec<u8>, String> {
    if password.chars().count() < 12 { return Err("Use a backup password of at least 12 characters.".into()); }
    let salt = uuid::Uuid::new_v4().as_bytes().to_vec();
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, ROUNDS, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plaintext = serde_json::to_vec(archive).map_err(|e| e.to_string())?;
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_slice()).map_err(|_| "Backup encryption failed")?;
    serde_json::to_vec(&Envelope { format: "kivo-workspace-backup".into(), version: 1, salt: STANDARD.encode(salt), nonce: STANDARD.encode(nonce), ciphertext: STANDARD.encode(ciphertext) }).map_err(|e| e.to_string())
}

fn open_archive(bytes: &[u8], password: &str) -> Result<Archive, String> {
    if bytes.len() > LIMIT * 2 { return Err("Backup file exceeds the size limit.".into()); }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "Invalid backup file")?;
    if envelope.format != "kivo-workspace-backup" || envelope.version != 1 { return Err("Unsupported backup version.".into()); }
    let salt = STANDARD.decode(envelope.salt).map_err(|_| "Invalid backup salt")?;
    let nonce = STANDARD.decode(envelope.nonce).map_err(|_| "Invalid backup nonce")?;
    if salt.len() != 16 || nonce.len() != 12 { return Err("Invalid backup encryption metadata.".into()); }
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, ROUNDS, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ciphertext = STANDARD.decode(envelope.ciphertext).map_err(|_| "Invalid encrypted backup")?;
    let plaintext = cipher.decrypt(Nonce::from_slice(&nonce), ciphertext.as_slice()).map_err(|_| "Incorrect password or damaged backup.")?;
    let archive: Archive = serde_json::from_slice(&plaintext).map_err(|_| "Invalid backup contents")?;
    if archive.version != 1 || archive.files.len() > 10_000 { return Err("Unsupported backup contents.".into()); }
    archive_files(&archive)?;
    Ok(archive)
}

fn archive_files(archive: &Archive) -> Result<BTreeMap<PathBuf, Vec<u8>>, String> {
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    let mut paths = std::collections::HashSet::new();
    for file in &archive.files {
        if file.path.contains('\\') || file.path.split('/').any(|part| part.is_empty() || part == "." || part == "..") { return Err("Backup contains an unsafe path.".into()); }
        let path = PathBuf::from(&file.path);
        validate_path(&path)?;
        if !paths.insert(file.path.to_lowercase()) { return Err("Backup has duplicate file paths.".into()); }
        let bytes = STANDARD.decode(&file.content).map_err(|_| "Invalid backup file content")?;
        total = total.checked_add(bytes.len()).ok_or("Backup is too large")?;
        if total > LIMIT || digest(&bytes) != file.sha256 { return Err("Backup integrity check failed.".into()); }
        files.insert(path, bytes);
    }
    if files.keys().any(|path| path.ancestors().skip(1).any(|parent| paths.contains(&parent.to_string_lossy().replace('\\', "/").to_lowercase()))) { return Err("Backup has overlapping file paths.".into()); }
    Ok(files)
}

fn rekey(value: &mut serde_json::Value, old: &str, new: &str) -> Result<(), String> {
    match value {
        serde_json::Value::String(text) if text.starts_with("enc:v1:") => *text = secrets::encrypt_sensitive_text_with_seed(&secrets::decrypt_sensitive_text_with_seed(text, old)?, new)?,
        serde_json::Value::Array(values) => for value in values { rekey(value, old, new)?; },
        serde_json::Value::Object(values) => for value in values.values_mut() { rekey(value, old, new)?; },
        _ => {},
    }
    Ok(())
}

fn preview(root: &Path, files: &BTreeMap<PathBuf, Vec<u8>>, created_at: String, digest: String) -> Result<BackupPreview, String> {
    for path in files.keys() { validate_path(path)?; durable::relative_path(root, &root.join(path))?; }
    Ok(BackupPreview { files: files.keys().map(|path| path.to_string_lossy().to_string()).collect(), overwrite_count: files.keys().filter(|path| root.join(path).exists()).count(), created_at, digest, storage_revision: restore_revision(root, files)? })
}

fn restore_revision(root: &Path, files: &BTreeMap<PathBuf, Vec<u8>>) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(root.to_string_lossy().as_bytes());
    for path in files.keys() {
        validate_path(path)?;
        let target = root.join(path);
        durable::relative_path(root, &target)?;
        hash.update(path.to_string_lossy().as_bytes());
        match fs::read(&target) {
            Ok(bytes) => { hash.update([1]); hash.update((bytes.len() as u64).to_le_bytes()); hash.update(bytes); }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => hash.update([0]),
            Err(error) => return Err(format!("Cannot inspect {}: {error}", path.display())),
        }
    }
    Ok(hex::encode(hash.finalize()))
}

fn restore_files(root: &Path, files: BTreeMap<PathBuf, Vec<u8>>, expected: &str) -> Result<(), String> {
    if restore_revision(root, &files)? != expected { return Err("Storage changed. Preview the restore again.".into()); }
    let mut plan = SavePlan::default();
    for (path, bytes) in files {
        validate_path(&path)?;
        let target = root.join(path);
        durable::relative_path(root, &target)?;
        plan.writes.insert(target, bytes);
    }
    durable::commit(root, plan)
}

fn read_backup(path: &str) -> Result<Vec<u8>, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > (LIMIT * 2) as u64 { return Err("Backup file exceeds the size limit.".into()); }
    fs::read(path).map_err(|e| e.to_string())
}

async fn background<T: Send + 'static>(job: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_workspace_backup(app: AppHandle, file_path: String, password: String) -> Result<(), String> {
    background(move || {
        if !Path::new(&file_path).extension().is_some_and(|value| value == "kivobak") { return Err("Choose a .kivobak destination file.".into()); }
        let root = super::get_storage_root(&app)?;
        let seed = secrets::get_or_create_auth_secret_seed(app)?;
        let mut files = BTreeMap::new();
        {
            let _guard = durable::storage_lock()?;
            durable::recover(&root)?;
            collect_files(&root, Path::new(""), &mut files, &mut 0)?;
        }
        let archive = Archive { version: 1, created_at: chrono::Utc::now().to_rfc3339(), auth_seed: seed, files: files.into_iter().map(|(path, bytes)| BackupFile { path: path.to_string_lossy().replace('\\', "/"), sha256: digest(&bytes), content: STANDARD.encode(bytes) }).collect() };
        durable::atomic_write(Path::new(&file_path), seal(&archive, &password)?)
    }).await
}

#[tauri::command]
pub async fn preview_workspace_backup(app: AppHandle, file_path: String, password: String) -> Result<BackupPreview, String> {
    background(move || {
        let bytes = read_backup(&file_path)?;
        let archive = open_archive(&bytes, &password)?;
        let _guard = durable::storage_lock()?;
        preview(&super::get_storage_root(&app)?, &archive_files(&archive)?, archive.created_at, digest(&bytes))
    }).await
}

#[tauri::command]
pub async fn restore_workspace_backup(app: AppHandle, file_path: String, password: String, expected_digest: String, expected_revision: String) -> Result<(), String> {
    background(move || {
        let bytes = read_backup(&file_path)?;
        if digest(&bytes) != expected_digest { return Err("Backup changed. Preview it again.".into()); }
        let archive = open_archive(&bytes, &password)?;
        let root = super::get_storage_root(&app)?;
        let seed = secrets::get_or_create_auth_secret_seed(app)?;
        let mut files = archive_files(&archive)?;
        if seed != archive.auth_seed {
            for (path, bytes) in &mut files {
                if path.extension().is_some_and(|extension| extension == "json") {
                    let mut json: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| format!("Cannot migrate credentials in {}", path.display()))?;
                    rekey(&mut json, &archive.auth_seed, &seed)?;
                    *bytes = serde_json::to_vec_pretty(&json).map_err(|e| e.to_string())?;
                }
            }
        }
        let _guard = durable::storage_lock()?;
        restore_files(&root, files, &expected_revision)
    }).await
}

fn recovery_directory(root: &Path, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid recovery entry")?;
    let directory = root.join(".kivo-recovery").join(id);
    for path in [root.join(".kivo-recovery"), directory.clone()] {
        if fs::symlink_metadata(path).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("Linked recovery paths are not supported.".into()); }
    }
    durable::relative_path(&directory, &directory.join("committed"))?;
    durable::relative_path(&directory, &directory.join("journal.json"))?;
    if !directory.join("committed").is_file() { return Err("Only completed saves can be restored.".into()); }
    Ok(directory)
}

fn read_retained(path: &Path, total: &mut usize) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > LIMIT as u64 || (*total as u64) + size > LIMIT as u64 { return Err("Recovery entry exceeds 64 MB.".into()); }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    *total += bytes.len();
    if *total > LIMIT { return Err("Recovery entry exceeds 64 MB.".into()); }
    Ok(bytes)
}

fn read_journal(directory: &Path) -> Result<RetainedJournal, String> {
    let path = directory.join("journal.json");
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 4_000_000 { return Err("Recovery journal exceeds the size limit.".into()); }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn retained_files(root: &Path, id: &str) -> Result<BTreeMap<PathBuf, Vec<u8>>, String> {
    let directory = recovery_directory(root, id)?;
    let journal = read_journal(&directory)?;
    if journal.writes.len() + journal.removals.len() > 10_000 { return Err("Recovery entry exceeds 10,000 files.".into()); }
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    for (index, file) in journal.writes.iter().enumerate().filter(|(_, file)| file.existed) {
        validate_path(&file.path)?;
        let source = directory.join("old").join(index.to_string());
        durable::relative_path(&directory, &source)?;
        let bytes = read_retained(&source, &mut total)?;
        files.insert(file.path.clone(), bytes);
    }
    for (index, target) in journal.removals.iter().enumerate() {
        validate_path(target)?;
        let source = directory.join("deleted").join(index.to_string());
        durable::relative_path(&directory, &source)?;
        if !source.exists() { continue; }
        if source.is_dir() { collect_files(&source, target, &mut files, &mut total)?; }
        else { files.insert(target.clone(), read_retained(&source, &mut total)?); }
    }
    if total > LIMIT || files.len() > 10_000 { return Err("Recovery entry exceeds the 64 MB or 10,000-file limit.".into()); }
    Ok(files)
}

fn retained_digest(files: &BTreeMap<PathBuf, Vec<u8>>) -> String {
    let mut hash = Sha256::new();
    for (path, bytes) in files { hash.update(path.to_string_lossy().as_bytes()); hash.update((bytes.len() as u64).to_le_bytes()); hash.update(bytes); }
    hex::encode(hash.finalize())
}

#[tauri::command]
pub async fn list_recovery_snapshots(app: AppHandle) -> Result<Vec<RecoveryEntry>, String> {
    background(move || {
        let root = super::get_storage_root(&app)?;
        let _guard = durable::storage_lock()?;
        durable::recover(&root)?;
        let directory = root.join(".kivo-recovery");
        if !directory.exists() { return Ok(vec![]); }
        let mut entries = vec![];
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let id = entry.file_name().to_string_lossy().to_string();
            let Ok(directory) = recovery_directory(&root, &id) else { continue; };
            let journal = read_journal(&directory)?;
            let created_at: chrono::DateTime<chrono::Utc> = fs::metadata(directory.join("committed")).and_then(|metadata| metadata.modified()).map_err(|e| e.to_string())?.into();
            entries.push(RecoveryEntry { id, created_at: created_at.to_rfc3339(), replaced_files: journal.writes.iter().filter(|file| file.existed).count(), deleted_items: journal.removals.len() });
        }
        entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(entries)
    }).await
}

#[tauri::command]
pub async fn preview_recovery_snapshot(app: AppHandle, id: String) -> Result<BackupPreview, String> {
    background(move || {
        let root = super::get_storage_root(&app)?;
        let _guard = durable::storage_lock()?;
        let files = retained_files(&root, &id)?;
        preview(&root, &files, String::new(), retained_digest(&files))
    }).await
}

#[tauri::command]
pub async fn restore_recovery_snapshot(app: AppHandle, id: String, expected_digest: String, expected_revision: String) -> Result<(), String> {
    background(move || {
        let root = super::get_storage_root(&app)?;
        let _guard = durable::storage_lock()?;
        let files = retained_files(&root, &id)?;
        if retained_digest(&files) != expected_digest { return Err("Recovery entry changed. Preview again.".into()); }
        restore_files(&root, files, &expected_revision)
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(paths: &[&str]) -> Archive {
        Archive { version: 1, created_at: "2026-10-09T00:00:00Z".into(), auth_seed: "fixture-seed".into(), files: paths.iter().map(|path| BackupFile { path: (*path).into(), content: STANDARD.encode(b"fixture"), sha256: digest(b"fixture") }).collect() }
    }

    #[test]
    fn encrypted_archive_authenticates_password_and_contents() {
        let original = archive(&["demo/workspace.json"]);
        assert!(seal(&original, "short").is_err());
        let bytes = seal(&original, "synthetic-password").unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("fixture-seed"));
        assert_eq!(open_archive(&bytes, "synthetic-password").unwrap().files[0].path, original.files[0].path);
        assert!(open_archive(&bytes, "incorrect-password").err().unwrap().contains("Incorrect password"));
        let mut envelope: Envelope = serde_json::from_slice(&bytes).unwrap();
        let mut cipher = STANDARD.decode(&envelope.ciphertext).unwrap();
        cipher[0] ^= 1;
        envelope.ciphertext = STANDARD.encode(cipher);
        assert!(open_archive(&serde_json::to_vec(&envelope).unwrap(), "synthetic-password").is_err());
    }

    #[test]
    fn archive_rejects_unsafe_and_ambiguous_paths() {
        for path in ["../outside", "/absolute", "a/./file", "a//file", "a\\file", "CON.json", ".git/config", ".kivo-recovery/x", "demo/file.", "demo/x:y"] {
            assert!(archive_files(&archive(&[path])).is_err(), "{path}");
        }
        assert!(archive_files(&archive(&["a.json", "A.json"])).is_err());
        assert!(archive_files(&archive(&["DEMO", "demo/file.json"])).is_err());
        let mut damaged = archive(&["a.json"]);
        damaged.files[0].sha256 = "wrong".into();
        assert!(archive_files(&damaged).is_err());
    }

    #[test]
    fn restore_guards_environment_edits_and_retains_replaced_files() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("demo/.env");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"TOKEN=old").unwrap();
        let files = BTreeMap::from([(PathBuf::from("demo/.env"), b"TOKEN=backup".to_vec())]);
        let revision = restore_revision(root.path(), &files).unwrap();
        fs::write(&target, b"TOKEN=edited").unwrap();
        assert!(restore_files(root.path(), files.clone(), &revision).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"TOKEN=edited");
        let revision = restore_revision(root.path(), &files).unwrap();
        restore_files(root.path(), files, &revision).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"TOKEN=backup");
        let id = fs::read_dir(root.path().join(".kivo-recovery")).unwrap().next().unwrap().unwrap().file_name().to_string_lossy().to_string();
        let retained = retained_files(root.path(), &id).unwrap();
        assert_eq!(retained[Path::new("demo/.env")], b"TOKEN=edited");
    }

    #[test]
    fn deleted_directories_can_be_previewed_and_restored() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("demo/collections/old/request.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{}").unwrap();
        durable::commit(root.path(), SavePlan { writes: BTreeMap::new(), removals: vec![path.parent().unwrap().to_path_buf()] }).unwrap();
        assert!(!path.exists());
        let id = fs::read_dir(root.path().join(".kivo-recovery")).unwrap().next().unwrap().unwrap().file_name().to_string_lossy().to_string();
        let files = retained_files(root.path(), &id).unwrap();
        let preview = preview(root.path(), &files, String::new(), retained_digest(&files)).unwrap();
        assert_eq!(preview.files.len(), 1);
        assert_eq!(preview.overwrite_count, 0);
        restore_files(root.path(), files, &preview.storage_revision).unwrap();
        assert_eq!(fs::read(path).unwrap(), b"{}");
    }

    #[test]
    fn portable_credentials_are_reencrypted_for_destination_key() {
        let encrypted = secrets::encrypt_sensitive_text_with_seed("synthetic-token", "source-key").unwrap();
        let mut json = serde_json::json!({"auth": {"token": encrypted}, "unchanged": true});
        rekey(&mut json, "source-key", "destination-key").unwrap();
        let moved = json["auth"]["token"].as_str().unwrap();
        assert_eq!(secrets::decrypt_sensitive_text_with_seed(moved, "destination-key").unwrap(), "synthetic-token");
        assert!(secrets::decrypt_sensitive_text_with_seed(moved, "source-key").is_err());
        assert_eq!(json["unchanged"], true);
    }
}
