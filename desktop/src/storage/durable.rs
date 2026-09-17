use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const RECOVERY_DIR: &str = ".kivo-recovery";
static STORAGE_LOCK: Mutex<()> = Mutex::new(());

pub fn storage_lock() -> Result<MutexGuard<'static, ()>, String> {
    STORAGE_LOCK.lock().map_err(|_| {
        "Storage is unavailable after an interrupted operation. Restart Kivo to recover."
            .to_string()
    })
}

pub fn atomic_write(path: &Path, data: impl AsRef<[u8]>) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing file parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".kivo-write-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(data.as_ref())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        sync_directory(parent)?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| format!("Could not save {}: {e}", path.display()))
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[derive(Default)]
pub struct SavePlan {
    pub writes: BTreeMap<PathBuf, Vec<u8>>,
    pub removals: Vec<PathBuf>,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    writes: Vec<PreviousFile>,
    removals: Vec<PathBuf>,
    #[serde(default)]
    created_directories: Vec<PathBuf>,
}

#[derive(Serialize, Deserialize)]
struct PreviousFile {
    path: PathBuf,
    existed: bool,
}

pub(crate) fn relative_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Storage path leaves its root")?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || relative.components().next() == Some(Component::Normal(RECOVERY_DIR.as_ref()))
    {
        return Err("Invalid storage path".to_string());
    }
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Linked storage paths are not supported".to_string())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(relative.to_path_buf())
}

fn prepare(root: &Path, plan: SavePlan) -> Result<Option<(PathBuf, Journal)>, String> {
    let mut writes = Vec::new();
    for (path, data) in plan.writes {
        let relative = relative_path(root, &path)?;
        let previous = match fs::read(&path) {
            Ok(bytes) if bytes == data => continue,
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("Cannot back up {}: {error}", path.display())),
        };
        writes.push((relative, data, previous));
    }
    let removals = plan
        .removals
        .iter()
        .map(|path| relative_path(root, path))
        .collect::<Result<Vec<_>, _>>()?;
    if writes.is_empty() && removals.is_empty() {
        return Ok(None);
    }
    let recovery = root.join(RECOVERY_DIR);
    if fs::symlink_metadata(&recovery).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Recovery directory must not be a symbolic link".to_string());
    }
    let directory = recovery.join(Uuid::new_v4().to_string());
    let mut created_directories = std::collections::BTreeSet::new();
    for (path, _, _) in &writes {
        let mut parent = root.join(path);
        parent.pop();
        while parent != root && !parent.exists() {
            created_directories.insert(relative_path(root, &parent)?);
            if !parent.pop() {
                break;
            }
        }
    }
    let mut journal = Journal {
        writes: Vec::new(),
        removals,
        created_directories: created_directories.into_iter().collect(),
    };
    // Stage every replacement and before-image before changing any live file.
    for (index, (path, data, previous)) in writes.into_iter().enumerate() {
        atomic_write(&directory.join("new").join(index.to_string()), data)?;
        if let Some(bytes) = &previous {
            atomic_write(&directory.join("old").join(index.to_string()), bytes)?;
        }
        journal.writes.push(PreviousFile {
            path,
            existed: previous.is_some(),
        });
    }
    atomic_write(
        &directory.join("journal.json"),
        serde_json::to_vec(&journal).map_err(|e| e.to_string())?,
    )?;
    Ok(Some((directory, journal)))
}

fn rollback(root: &Path, directory: &Path, journal: &Journal) -> Result<(), String> {
    for (index, path) in journal.removals.iter().enumerate().rev() {
        let target = root.join(path);
        relative_path(root, &target)?;
        let backup = directory.join("deleted").join(index.to_string());
        if backup.exists() {
            if target.exists() {
                return Err(format!(
                    "Recovery conflict at {}. Original data remains in {}",
                    target.display(),
                    backup.display()
                ));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::rename(&backup, &target).map_err(|e| e.to_string())?;
        }
    }
    for (index, previous) in journal.writes.iter().enumerate().rev() {
        let target = root.join(&previous.path);
        relative_path(root, &target)?;
        if previous.existed {
            let bytes = fs::read(directory.join("old").join(index.to_string()))
                .map_err(|e| e.to_string())?;
            atomic_write(&target, bytes)?;
        } else if target.exists() {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
    }
    let mut created = journal.created_directories.iter().collect::<Vec<_>>();
    created.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in created {
        let target = root.join(path);
        relative_path(root, &target)?;
        match fs::remove_dir(&target) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    atomic_write(&directory.join("rolled-back"), b"ok")
}

pub fn recover(root: &Path) -> Result<(), String> {
    let recovery = root.join(RECOVERY_DIR);
    if fs::symlink_metadata(&recovery).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("Recovery directory must not be a symbolic link".to_string());
    }
    if !recovery.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(&recovery).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let directory = entry.path();
        let manifest = directory.join("journal.json");
        if !manifest.exists()
            || directory.join("committed").exists()
            || directory.join("rolled-back").exists()
        {
            continue;
        }
        let journal = serde_json::from_slice(&fs::read(manifest).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Cannot read recovery journal: {e}"))?;
        rollback(root, &directory, &journal)?;
    }
    Ok(())
}

fn prune_replaced_files(root: &Path) {
    let recovery = root.join(RECOVERY_DIR);
    let Ok(entries) = fs::read_dir(&recovery) else {
        return;
    };
    let mut completed = entries
        .flatten()
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_dir()
                || Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err()
            {
                return None;
            }
            let directory = entry.path();
            // Deleted collections stay recoverable until explicitly cleared by the user.
            if directory.join("deleted").exists() || !directory.join("committed").is_file() {
                return None;
            }
            Some((
                fs::metadata(directory.join("committed"))
                    .ok()?
                    .modified()
                    .ok()?,
                directory,
            ))
        })
        .collect::<Vec<_>>();
    completed.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, directory) in completed.into_iter().skip(20) {
        if directory.parent() == Some(recovery.as_path()) {
            let _ = fs::remove_dir_all(directory);
        }
    }
}

pub fn commit(root: &Path, plan: SavePlan) -> Result<(), String> {
    let Some((directory, journal)) = prepare(root, plan)? else {
        return Ok(());
    };
    let result = (|| {
        for (index, replacement) in journal.writes.iter().enumerate() {
            let target = root.join(&replacement.path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::rename(directory.join("new").join(index.to_string()), &target)
                .map_err(|e| e.to_string())?;
            sync_directory(target.parent().ok_or("Missing file parent")?)
                .map_err(|e| e.to_string())?;
        }
        for (index, path) in journal.removals.iter().enumerate() {
            let target = root.join(path);
            if target.exists() {
                let backup = directory.join("deleted").join(index.to_string());
                fs::create_dir_all(backup.parent().ok_or("Missing backup parent")?)
                    .map_err(|e| e.to_string())?;
                fs::rename(&target, backup).map_err(|e| e.to_string())?;
                sync_directory(target.parent().ok_or("Missing file parent")?)
                    .map_err(|e| e.to_string())?;
            }
        }
        atomic_write(&directory.join("committed"), b"ok")
    })();
    if let Err(error) = result {
        rollback(root, &directory, &journal)
            .map_err(|recovery| format!("Save failed: {error}. Recovery pending: {recovery}"))?;
        return Err(format!("Save failed; previous files restored: {error}"));
    }
    prune_replaced_files(root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn interrupted_save_restores_all_before_images() {
        let root = TempDir::new().unwrap();
        let original = root.path().join("request.json");
        atomic_write(&original, b"old").unwrap();
        let mut plan = SavePlan::default();
        plan.writes.insert(original.clone(), b"new".to_vec());
        plan.writes
            .insert(root.path().join("added.json"), b"added".to_vec());
        let (directory, journal) = prepare(root.path(), plan).unwrap().unwrap();
        for (index, file) in journal.writes.iter().enumerate() {
            fs::rename(
                directory.join("new").join(index.to_string()),
                root.path().join(&file.path),
            )
            .unwrap();
        }
        recover(root.path()).unwrap();
        recover(root.path()).unwrap();
        assert_eq!(fs::read(original).unwrap(), b"old");
        assert!(!root.path().join("added.json").exists());
    }

    #[test]
    fn failed_preparation_does_not_touch_live_files() {
        let root = TempDir::new().unwrap();
        let original = root.path().join("a.json");
        atomic_write(&original, b"old").unwrap();
        fs::create_dir(root.path().join("z.json")).unwrap();
        let mut plan = SavePlan::default();
        plan.writes.insert(original.clone(), b"new".to_vec());
        plan.writes
            .insert(root.path().join("z.json"), b"invalid".to_vec());
        assert!(commit(root.path(), plan).is_err());
        assert_eq!(fs::read(original).unwrap(), b"old");
    }

    #[test]
    fn interrupted_deletion_restores_the_entire_directory() {
        let root = TempDir::new().unwrap();
        let original = root.path().join("workspace/private.env");
        atomic_write(&original, b"secret fixture").unwrap();
        let mut plan = SavePlan::default();
        plan.removals.push(root.path().join("workspace"));
        let (directory, _) = prepare(root.path(), plan).unwrap().unwrap();
        fs::create_dir_all(directory.join("deleted")).unwrap();
        fs::rename(root.path().join("workspace"), directory.join("deleted/0")).unwrap();
        recover(root.path()).unwrap();
        assert_eq!(fs::read(original).unwrap(), b"secret fixture");
    }

    #[test]
    fn interrupted_rename_restores_source_and_removes_new_directories() {
        let root = TempDir::new().unwrap();
        atomic_write(&root.path().join("original/.env"), b"secret").unwrap();
        let mut plan = SavePlan::default();
        plan.writes
            .insert(root.path().join("renamed/.env"), b"secret".to_vec());
        plan.removals.push(root.path().join("original"));
        let (directory, _) = prepare(root.path(), plan).unwrap().unwrap();
        fs::create_dir(root.path().join("renamed")).unwrap();
        fs::rename(directory.join("new/0"), root.path().join("renamed/.env")).unwrap();
        fs::create_dir_all(directory.join("deleted")).unwrap();
        fs::rename(root.path().join("original"), directory.join("deleted/0")).unwrap();
        recover(root.path()).unwrap();
        assert_eq!(
            fs::read(root.path().join("original/.env")).unwrap(),
            b"secret"
        );
        assert!(!root.path().join("renamed").exists());
    }

    #[test]
    fn deletion_is_recoverable_and_commit_is_not_rolled_back() {
        let root = TempDir::new().unwrap();
        let original = root.path().join("workspace").join("private.env");
        atomic_write(&original, b"preserved").unwrap();
        let mut plan = SavePlan::default();
        plan.removals.push(root.path().join("workspace"));
        commit(root.path(), plan).unwrap();
        recover(root.path()).unwrap();
        assert!(!original.exists());
        let transaction = fs::read_dir(root.path().join(RECOVERY_DIR))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        assert_eq!(
            fs::read(transaction.join("deleted/0/private.env")).unwrap(),
            b"preserved"
        );
    }

    #[test]
    fn unchanged_data_does_not_create_a_transaction() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("request.json");
        atomic_write(&path, b"same").unwrap();
        let mut plan = SavePlan::default();
        plan.writes.insert(path, b"same".to_vec());
        commit(root.path(), plan).unwrap();
        assert!(!root.path().join(RECOVERY_DIR).exists());
    }
}
