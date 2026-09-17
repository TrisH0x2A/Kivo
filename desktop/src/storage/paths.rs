use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::{durable, io, models::WorkspaceRecord};

fn validate_component(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2"
                    | "3"
                    | "4"
                    | "5"
                    | "6"
                    | "7"
                    | "8"
                    | "9"
                    | "\u{00b9}"
                    | "\u{00b2}"
                    | "\u{00b3}"
            )
        })
    });
    if name.is_empty()
        || name != name.trim()
        || name.ends_with('.')
        || reserved
        || name.encode_utf16().count() > 240
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return Err(format!("Invalid storage name: {name:?}"));
    }
    Ok(())
}

pub fn workspace_dir(root: &Path, name: &str) -> Result<PathBuf, String> {
    validate_component(name)?;
    if name.eq_ignore_ascii_case(".kivo-recovery") {
        return Err("This workspace name is reserved for recovery storage".to_string());
    }
    let path = root.join(name);
    validate_directory(root, &path)?;
    Ok(path)
}

pub fn collection_dir(root: &Path, workspace: &str, name: &str) -> Result<PathBuf, String> {
    let safe = io::sanitize_name(name);
    validate_component(&safe)?;
    let path = workspace_dir(root, workspace)?
        .join("collections")
        .join(safe);
    validate_directory(root, &path)?;
    Ok(path)
}

fn validate_directory(root: &Path, path: &Path) -> Result<(), String> {
    durable::relative_path(root, path)?;
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if parent.is_dir() {
            for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
                let existing = entry.map_err(|e| e.to_string())?.file_name();
                if existing != name
                    && existing.to_string_lossy().to_lowercase()
                        == name.to_string_lossy().to_lowercase()
                {
                    return Err(format!(
                        "Storage destination differs only by case: {}",
                        path.display()
                    ));
                }
            }
        }
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
                return Err(format!(
                    "Linked storage entries are not supported: {}",
                    entry.path().display()
                ));
            }
        }
    }
    Ok(())
}

pub fn request_filename(name: &str) -> Result<String, String> {
    let safe = io::sanitize_name(name);
    validate_component(&safe)?;
    let filename = format!("{safe}.json");
    if [
        io::COLLECTION_CONFIG_FILE_NAME,
        io::COLLECTION_STATE_FILE_NAME,
        io::WORKSPACE_FILE_NAME,
    ]
    .iter()
    .any(|reserved| filename.eq_ignore_ascii_case(reserved))
    {
        return Err(format!("Request name {name:?} is reserved for metadata"));
    }
    Ok(filename)
}

pub fn metadata_collection_dir(
    root: &Path,
    workspace: &Path,
    relative: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || relative.components().next() != Some(Component::Normal("collections".as_ref()))
        || relative.components().count() < 2
    {
        return Err("Collection metadata contains an unsafe path".to_string());
    }
    let path = workspace.join(relative);
    validate_directory(root, &path)?;
    Ok(path)
}

fn register_path(
    paths: &mut HashMap<String, String>,
    physical: String,
    logical: String,
) -> Result<(), String> {
    if let Some(previous) = paths.insert(physical.to_lowercase(), logical.clone()) {
        if previous != logical {
            return Err(format!(
                "Storage name collision between {previous:?} and {logical:?}"
            ));
        }
    }
    Ok(())
}

fn validate_folder(path: &str, aliases: &mut HashMap<String, String>) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    let mut physical = PathBuf::new();
    let mut logical = Vec::new();
    for segment in path.split(['/', '\\']) {
        let safe = io::sanitize_name(segment);
        validate_component(&safe)?;
        physical.push(safe);
        logical.push(segment);
        register_path(
            aliases,
            physical.to_string_lossy().to_string(),
            logical.join("/"),
        )?;
    }
    Ok(())
}

pub fn validate_snapshot(root: &Path, workspaces: &[WorkspaceRecord]) -> Result<(), String> {
    let mut workspace_paths = HashMap::new();
    for workspace in workspaces {
        workspace_dir(root, &workspace.name)?;
        register_path(
            &mut workspace_paths,
            workspace.name.clone(),
            workspace.name.clone(),
        )?;
        let mut collection_paths = HashMap::new();
        for collection in &workspace.collections {
            let path = collection_dir(root, &workspace.name, &collection.name)?;
            register_path(
                &mut collection_paths,
                io::sanitize_name(&collection.name),
                collection.name.clone(),
            )?;
            let mut folders = HashMap::new();
            let mut requests = HashMap::new();
            for folder in &collection.folders {
                validate_folder(folder, &mut folders)?;
            }
            for setting in &collection.folder_settings {
                validate_folder(&setting.path, &mut folders)?;
            }
            for request in &collection.requests {
                validate_folder(&request.folder_path, &mut folders)?;
                let filename = request_filename(&request.name)?;
                let target = io::collection_subdir_path(&path, &request.folder_path).join(filename);
                durable::relative_path(root, &target)?;
                register_path(
                    &mut requests,
                    target
                        .strip_prefix(&path)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .to_string(),
                    format!("{}/{}", request.folder_path, request.name),
                )?;
            }
            for request_path in requests.keys() {
                if folders.contains_key(request_path) {
                    return Err(format!(
                        "A request and folder target the same path: {request_path}"
                    ));
                }
            }
        }
    }
    Ok(())
}
