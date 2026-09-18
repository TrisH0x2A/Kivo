use super::*;
use std::collections::HashSet;

pub(super) fn storage_identity(id: &str, name: &str) -> String {
    if id.is_empty() {
        format!("legacy:{name}")
    } else {
        id.to_string()
    }
}

pub(super) struct ExistingWorkspace {
    pub path: PathBuf,
    pub collections: HashMap<String, PathBuf>,
}

pub(super) fn existing_workspaces(
    root: &Path,
) -> Result<HashMap<String, ExistingWorkspace>, String> {
    let mut result = HashMap::new();
    if !root.exists() {
        return Ok(result);
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let metadata = path.join(WORKSPACE_FILE_NAME);
        if !metadata.exists() {
            continue;
        }
        durable::relative_path(root, &metadata)?;
        let file: WorkspaceFile =
            serde_json::from_slice(&fs::read(&metadata).map_err(|e| e.to_string())?)
                .map_err(|e| format!("Cannot read {}: {e}", metadata.display()))?;
        let mut collections = HashMap::new();
        for collection in file.collections {
            let id = storage_identity(&collection.id, &collection.name);
            let collection_path =
                super::super::paths::metadata_collection_dir(root, &path, &collection.path)?;
            if collections.insert(id, collection_path).is_some() {
                return Err("Duplicate collection identity in workspace metadata".to_string());
            }
        }
        let id = storage_identity(&file.info.id, &file.info.name);
        if result
            .insert(id, ExistingWorkspace { path, collections })
            .is_some()
        {
            return Err("Duplicate workspace identity in storage".to_string());
        }
    }
    Ok(result)
}

pub(super) fn validate_identities(
    root: &Path,
    workspaces: &[WorkspaceRecord],
) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for workspace in workspaces {
        let path = root.join(&workspace.name);
        durable::relative_path(root, &path)?;
        if !ids.insert(storage_identity(&workspace.id, &workspace.name))
            || !paths.insert(path.clone())
        {
            return Err("Duplicate workspace identity or destination".to_string());
        }
        let mut collection_ids = HashSet::new();
        let mut collection_paths = HashSet::new();
        for collection in &workspace.collections {
            let path = get_collection_dir(root, &workspace.name, &collection.name);
            durable::relative_path(root, &path)?;
            if !collection_ids.insert(storage_identity(&collection.id, &collection.name))
                || !collection_paths.insert(path)
            {
                return Err("Duplicate collection identity or destination".to_string());
            }
        }
    }
    Ok(())
}

pub(super) fn stage_rename(
    root: &Path,
    source: &Path,
    target: &Path,
    workspace: bool,
    plan: &mut SavePlan,
) -> Result<(), String> {
    if source == target {
        return Ok(());
    }
    durable::relative_path(root, source)?;
    durable::relative_path(root, target)?;
    if target.exists() {
        return Err(format!(
            "Cannot rename to {}: destination already exists",
            target.display()
        ));
    }
    let mut pending = vec![source.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|e| format!("Cannot read rename source: {e}"))?
        {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let relative = path.strip_prefix(source).map_err(|e| e.to_string())?;
            // Collections have their own identities and may be renamed in this same save.
            if workspace && relative == Path::new("collections") {
                continue;
            }
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                return Err(format!(
                    "Cannot rename linked storage path {}",
                    path.display()
                ));
            }
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                plan.writes.insert(
                    target.join(relative),
                    fs::read(path).map_err(|e| e.to_string())?,
                );
            }
        }
    }
    Ok(())
}

pub(super) fn stage_defaults(path: &Path, plan: &mut SavePlan) -> Result<(), String> {
    let env = path.join(".env");
    if !env.exists() {
        plan.writes.entry(env).or_default();
    }
    let ignore = path.join(".gitignore");
    let content = match plan.writes.get(&ignore) {
        Some(bytes) => String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?,
        None => match fs::read_to_string(&ignore) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        },
    };
    plan.writes.insert(
        ignore,
        protected_ignore_content(&content, ".env\n.env.*\n").into_bytes(),
    );
    Ok(())
}

pub(super) fn protected_ignore_content(content: &str, rules: &str) -> String {
    if content.ends_with(rules) {
        return content.to_string();
    }
    format!(
        "{}{}{}",
        content,
        if content.is_empty() || content.ends_with('\n') {
            ""
        } else {
            "\n"
        },
        rules
    )
}

pub(super) fn read_ignore_file(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Cannot read ignore rules: {error}")),
    }
}
