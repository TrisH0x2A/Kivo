use crate::storage::models::{
    default_auth_record, CollectionRecord, ImportedCollectionResult, KeyValueRow, RequestRecord,
    RequestTextOrJson,
};
use serde_json::Value;
use std::collections::BTreeSet;

fn empty_request(name: String, method: String, url: String) -> RequestRecord {
    RequestRecord {
        name,
        request_mode: "http".to_string(),
        method,
        url,
        query_params: vec![],
        headers: vec![],
        auth: default_auth_record(),
        body_type: "none".to_string(),
        body: RequestTextOrJson::Text(String::new()),
        body_rows: vec![],
        body_file_path: String::new(),
        graphql_variables: RequestTextOrJson::Text(String::new()),
        grpc_proto_file_path: String::new(),
        grpc_method_path: String::new(),
        grpc_streaming_mode: "bidi".to_string(),
        grpc_direct_proto_files: vec![],
        grpc_proto_directories: vec![],
        docs: String::new(),
        tags: vec![],
        url_encoding: true,
        follow_redirects: true,
        max_redirects: 5,
        timeout_ms: 0,
        use_cookie_jar: true,
        proxy_mode: String::new(),
        proxy_http: String::new(),
        proxy_https: String::new(),
        no_proxy: String::new(),
        client_certificate_path: String::new(),
        client_key_path: String::new(),
        folder_path: String::new(),
        script_pre_request: String::new(),
        script_after_response: String::new(),
        script_active_phase: "pre-request".to_string(),
        script_last_run_at: String::new(),
        script_last_phase: String::new(),
        script_last_status: String::new(),
        script_last_error: String::new(),
        script_last_logs: vec![],
        script_last_tests: vec![],
        script_last_vars: std::collections::HashMap::new(),
        active_editor_tab: "Params".to_string(),
        active_response_tab: "Body".to_string(),
        response_body_view: "JSON".to_string(),
        last_response: None,
    }
}

fn split_url_query(raw_url: &str) -> (String, Vec<KeyValueRow>) {
    let url = raw_url.trim();
    let mut rows = vec![];
    let Some((base, query)) = url.split_once('?') else {
        return (url.to_string(), rows);
    };
    for part in query.split('&') {
        if part.trim().is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        rows.push(KeyValueRow {
            key: key.to_string(),
            value: value.to_string(),
            enabled: true,
            field_type: String::new(),
            file_path: String::new(),
        });
    }
    (base.to_string(), rows)
}

fn as_str(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map_or_else(String::new, ToString::to_string)
}

fn parse_headers_array(value: Option<&Value>) -> Vec<KeyValueRow> {
    let mut headers = vec![];
    if let Some(items) = value.and_then(|v| v.as_array()) {
        for item in items {
            let key = as_str(item.get("key"));
            if key.trim().is_empty() {
                continue;
            }
            headers.push(KeyValueRow {
                key,
                value: as_str(item.get("value")),
                enabled: item
                    .get("disabled")
                    .and_then(|v| v.as_bool())
                    .map_or(true, |v| !v),
                field_type: String::new(),
                file_path: String::new(),
            });
        }
    }
    headers
}

fn parse_headers_object(value: Option<&Value>) -> Vec<KeyValueRow> {
    let mut headers = vec![];
    if let Some(obj) = value.and_then(|v| v.as_object()) {
        for (key, value) in obj {
            if key.trim().is_empty() {
                continue;
            }
            headers.push(KeyValueRow {
                key: key.to_string(),
                value: value.as_str().unwrap_or("").to_string(),
                enabled: true,
                field_type: String::new(),
                file_path: String::new(),
            });
        }
    }
    headers
}

fn parse_headers_any(value: Option<&Value>) -> Vec<KeyValueRow> {
    let array_headers = parse_headers_array(value);
    if !array_headers.is_empty() {
        return array_headers;
    }
    parse_headers_object(value)
}

fn parse_url_value(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(url) = value.as_str() {
        return url.to_string();
    }
    as_str(value.get("raw"))
        .if_empty_then(|| as_str(value.get("url")))
        .if_empty_then(|| as_str(value.get("href")))
}

fn parse_postman_url(url: Option<&Value>) -> String {
    let Some(url) = url else {
        return String::new();
    };
    if let Some(raw) = url.as_str() {
        return raw.to_string();
    }
    if let Some(raw) = url.get("raw").and_then(|v| v.as_str()) {
        return raw.to_string();
    }

    let host = url
        .get("host")
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(".")
        })
        .unwrap_or_default();
    let path = url
        .get("path")
        .and_then(|v| v.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default();

    let mut built = if host.is_empty() {
        format!("/{}", path.trim_start_matches('/'))
    } else {
        format!("https://{}/{}", host, path.trim_start_matches('/'))
    };

    if let Some(query) = url.get("query").and_then(|v| v.as_array()) {
        let pairs = query
            .iter()
            .filter_map(|entry| {
                let key = entry.get("key").and_then(|v| v.as_str())?;
                if key.trim().is_empty() {
                    return None;
                }
                let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("");
                Some(format!("{}={}", key, value))
            })
            .collect::<Vec<_>>();
        if !pairs.is_empty() {
            built.push('?');
            built.push_str(&pairs.join("&"));
        }
    }

    built
}

fn import_postman_items(
    items: &[Value],
    folder_prefix: &str,
    requests: &mut Vec<RequestRecord>,
    folders: &mut BTreeSet<String>,
) {
    for item in items {
        let name = as_str(item.get("name"));
        if let Some(children) = item.get("item").and_then(|v| v.as_array()) {
            let next_folder = if folder_prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", folder_prefix, name)
            };
            if !next_folder.trim().is_empty() {
                folders.insert(next_folder.clone());
            }
            import_postman_items(children, &next_folder, requests, folders);
            continue;
        }

        let req_json = item.get("request").unwrap_or(&Value::Null);
        let method = as_str(req_json.get("method")).to_uppercase();
        let raw_url = parse_postman_url(req_json.get("url"));
        let (url, query_params) = split_url_query(&raw_url);

        let mut request = empty_request(
            if name.trim().is_empty() {
                format!(
                    "{} {}",
                    if method.is_empty() { "GET" } else { &method },
                    if url.is_empty() { "/" } else { &url }
                )
            } else {
                name
            },
            if method.is_empty() {
                "GET".to_string()
            } else {
                method
            },
            url,
        );
        request.query_params = query_params;
        request.headers = parse_headers_array(req_json.get("header"));
        request.folder_path = folder_prefix.to_string();

        if let Some(body) = req_json.get("body") {
            let mode = as_str(body.get("mode"));
            if mode == "raw" {
                request.body_type = "json".to_string();
                request.body = RequestTextOrJson::Text(as_str(body.get("raw")));
            } else if mode == "urlencoded" || mode == "formdata" {
                request.body_type = if mode == "urlencoded" {
                    "form-urlencoded".to_string()
                } else {
                    "form-data".to_string()
                };
                request.body_rows = body
                    .get(if mode == "urlencoded" {
                        "urlencoded"
                    } else {
                        "formdata"
                    })
                    .and_then(|v| v.as_array())
                    .map(|rows| {
                        rows.iter()
                            .map(|row| KeyValueRow {
                                key: as_str(row.get("key")),
                                value: as_str(row.get("value")),
                                enabled: row
                                    .get("disabled")
                                    .and_then(|v| v.as_bool())
                                    .map_or(true, |v| !v),
                                field_type: String::new(),
                                file_path: String::new(),
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
            }
        }

        requests.push(request);
    }
}

fn normalize_imported_kivo_collection(mut collection: CollectionRecord) -> CollectionRecord {
    if collection.name.trim().is_empty() {
        collection.name = "Kivo Import".to_string();
    }

    for request in &mut collection.requests {
        if request.name.trim().is_empty() {
            request.name = format!(
                "{} {}",
                if request.method.trim().is_empty() {
                    "GET"
                } else {
                    request.method.as_str()
                },
                if request.url.trim().is_empty() {
                    "/"
                } else {
                    request.url.as_str()
                }
            );
        }
    }

    if collection.folders.is_empty() {
        let mut folders = BTreeSet::new();
        for request in &collection.requests {
            if !request.folder_path.trim().is_empty() {
                folders.insert(request.folder_path.trim().to_string());
            }
        }
        collection.folders = folders.into_iter().collect();
    }

    collection
}

fn import_kivo(value: &Value) -> Result<CollectionRecord, String> {
    if value
        .get("type")
        .and_then(|v| v.as_str())
        .map(|kind| kind.eq_ignore_ascii_case("request"))
        .unwrap_or(false)
    {
        if let Some(request_value) = value.get("request") {
            let mut request = serde_json::from_value::<RequestRecord>(request_value.clone())
                .map_err(|e| format!("Invalid Kivo request JSON: {e}"))?;
            if request.name.trim().is_empty() {
                request.name = "Imported Request".to_string();
            }
            let folder_path = request.folder_path.trim().to_string();
            return Ok(CollectionRecord {
                name: "Kivo Request Import".to_string(),
                folders: if folder_path.is_empty() {
                    vec![]
                } else {
                    vec![folder_path]
                },
                folder_settings: vec![],
                requests: vec![request],
            });
        }
    }

    if let Some(collection_value) = value.get("collection") {
        if let Ok(collection) = serde_json::from_value::<CollectionRecord>(collection_value.clone()) {
            return Ok(normalize_imported_kivo_collection(collection));
        }
    }

    if let Ok(collection) = serde_json::from_value::<CollectionRecord>(value.clone()) {
        return Ok(normalize_imported_kivo_collection(collection));
    }

    if let Some(request_value) = value.get("request") {
        if let Ok(mut request) = serde_json::from_value::<RequestRecord>(request_value.clone()) {
            if request.name.trim().is_empty() {
                request.name = "Imported Request".to_string();
            }
            let folder_path = request.folder_path.trim().to_string();
            return Ok(CollectionRecord {
                name: "Kivo Request Import".to_string(),
                folders: if folder_path.is_empty() {
                    vec![]
                } else {
                    vec![folder_path]
                },
                folder_settings: vec![],
                requests: vec![request],
            });
        }
    }

    if let Ok(mut request) = serde_json::from_value::<RequestRecord>(value.clone()) {
        if request.name.trim().is_empty() {
            request.name = "Imported Request".to_string();
        }
        let folder_path = request.folder_path.trim().to_string();
        return Ok(CollectionRecord {
            name: "Kivo Request Import".to_string(),
            folders: if folder_path.is_empty() {
                vec![]
            } else {
                vec![folder_path]
            },
            folder_settings: vec![],
            requests: vec![request],
        });
    }

    Err("Unsupported Kivo JSON payload. Provide a Kivo request or collection export file.".to_string())
}

pub fn detect_format(value: &Value) -> String {
    if value.get("kivo").is_some()
        || value.get("kivoVersion").is_some()
        || value.get("requestMode").is_some()
        || value.get("request_mode").is_some()
        || value
            .get("collection")
            .and_then(|v| v.get("folderSettings"))
            .is_some()
        || value.get("folderSettings").is_some()
        || value.get("folder_settings").is_some()
    {
        return "kivo".to_string();
    }

    if value.get("openapi").is_some() {
        return "openapi3".to_string();
    }
    if value
        .get("swagger")
        .and_then(|v| v.as_str())
        == Some("2.0")
    {
        return "swagger2".to_string();
    }
    if value.get("item").is_some()
        || value
            .get("info")
            .and_then(|v| v.get("_postman_id"))
            .is_some()
    {
        return "postman".to_string();
    }
    if value.get("requests").is_some()
        || value.get("folders").is_some()
        || value.get("bruno").is_some()
        || value.get("collection").is_some()
        || value.get("items").is_some()
    {
        return "bruno".to_string();
    }
    "unknown".to_string()
}

fn import_openapi_like(value: &Value, format: &str) -> CollectionRecord {
    let name = value
        .get("info")
        .and_then(|v| v.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or(if format == "swagger2" {
            "Swagger Import"
        } else {
            "OpenAPI Import"
        })
        .to_string();

    let mut requests = vec![];
    if let Some(paths) = value.get("paths").and_then(|v| v.as_object()) {
        for (path, path_item) in paths {
            let Some(path_obj) = path_item.as_object() else {
                continue;
            };
            for method in ["get", "post", "put", "patch", "delete", "head", "options"] {
                let Some(op) = path_obj.get(method) else {
                    continue;
                };
                let op_name = op
                    .get("operationId")
                    .and_then(|v| v.as_str())
                    .or_else(|| op.get("summary").and_then(|v| v.as_str()))
                    .unwrap_or("");
                let req_name = if op_name.trim().is_empty() {
                    format!("{} {}", method.to_uppercase(), path)
                } else {
                    op_name.to_string()
                };
                let mut request = empty_request(req_name, method.to_uppercase(), path.to_string());

                if let Some(params) = op.get("parameters").and_then(|v| v.as_array()) {
                    for param in params {
                        if param.get("in").and_then(|v| v.as_str()) == Some("query") {
                            let key = as_str(param.get("name"));
                            if key.trim().is_empty() {
                                continue;
                            }
                            request.query_params.push(KeyValueRow {
                                key,
                                value: String::new(),
                                enabled: true,
                                field_type: String::new(),
                                file_path: String::new(),
                            });
                        }
                    }
                }

                requests.push(request);
            }
        }
    }

    CollectionRecord {
        name,
        folders: vec![],
        folder_settings: vec![],
        requests,
    }
}

fn import_bruno(value: &Value) -> CollectionRecord {
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .get("info")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            value
                .get("collection")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("Bruno Import")
        .to_string();

    let mut requests = vec![];
    let mut folders = BTreeSet::new();

    fn collect_bruno_items(
        items: &[Value],
        folder_prefix: &str,
        folders: &mut BTreeSet<String>,
        requests: &mut Vec<RequestRecord>,
    ) {
        for item in items {
            let name = as_str(item.get("name"))
                .if_empty_then(|| as_str(item.get("info").and_then(|info| info.get("name"))));
            let node_type = as_str(item.get("type"))
                .if_empty_then(|| as_str(item.get("info").and_then(|info| info.get("type"))))
                .to_lowercase();
            let child_items = item
                .get("items")
                .and_then(|v| v.as_array())
                .or_else(|| item.get("item").and_then(|v| v.as_array()))
                .or_else(|| item.get("requests").and_then(|v| v.as_array()));

            if child_items.is_some()
                && (node_type == "folder"
                    || node_type == "group"
                    || node_type == "collection"
                    || item.get("request").is_none())
            {
                let next_folder = if folder_prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", folder_prefix, name)
                };
                if !next_folder.trim().is_empty() {
                    folders.insert(next_folder.clone());
                }
                if let Some(children) = child_items {
                    collect_bruno_items(children, &next_folder, folders, requests);
                }
                continue;
            }

            let method = as_str(item.get("method"))
                .if_empty_then(|| as_str(item.get("request").and_then(|req| req.get("method"))))
                .if_empty_then(|| as_str(item.get("http").and_then(|http| http.get("method"))))
                .if_empty_then(|| {
                    as_str(
                        item.get("graphql")
                            .and_then(|graphql| graphql.get("method")),
                    )
                })
                .to_uppercase();
            let url = parse_url_value(item.get("url"))
                .if_empty_then(|| {
                    parse_url_value(item.get("request").and_then(|req| req.get("url")))
                })
                .if_empty_then(|| as_str(item.get("request").and_then(|req| req.get("rawUrl"))))
                .if_empty_then(|| {
                    parse_url_value(item.get("http").and_then(|http| http.get("url")))
                })
                .if_empty_then(|| {
                    parse_url_value(item.get("graphql").and_then(|graphql| graphql.get("url")))
                });

            if method.trim().is_empty() && url.trim().is_empty() {
                continue;
            }

            let mut request = empty_request(
                name.if_empty_then(|| {
                    format!(
                        "{} {}",
                        if method.is_empty() { "GET" } else { &method },
                        if url.is_empty() { "/" } else { &url }
                    )
                }),
                if method.is_empty() {
                    "GET".to_string()
                } else {
                    method
                },
                url,
            );

            request.folder_path = as_str(item.get("folder"));
            if request.folder_path.trim().is_empty() {
                request.folder_path = folder_prefix.to_string();
            }
            if !request.folder_path.is_empty() {
                folders.insert(request.folder_path.clone());
            }

            request.headers = parse_headers_any(
                item.get("headers")
                    .or_else(|| item.get("request").and_then(|req| req.get("headers")))
                    .or_else(|| item.get("http").and_then(|http| http.get("headers"))),
            );

            if let Some(body) = item
                .get("body")
                .and_then(|v| v.as_str())
                .or_else(|| {
                    item.get("request")
                        .and_then(|req| req.get("body"))
                        .and_then(|v| v.as_str())
                })
                .or_else(|| {
                    item.get("request")
                        .and_then(|req| req.get("body"))
                        .and_then(|v| v.get("raw"))
                        .and_then(|v| v.as_str())
                })
                .or_else(|| {
                    item.get("http")
                        .and_then(|http| http.get("body"))
                        .and_then(|v| v.get("raw"))
                        .and_then(|v| v.as_str())
                })
                .or_else(|| {
                    item.get("http")
                        .and_then(|http| http.get("body"))
                        .and_then(|v| v.get("data"))
                        .and_then(|v| v.as_str())
                })
                .or_else(|| {
                    item.get("graphql")
                        .and_then(|graphql| graphql.get("body"))
                        .and_then(|v| v.get("query"))
                        .and_then(|v| v.as_str())
                })
            {
                request.body_type = if node_type == "graphql" {
                    "graphql".to_string()
                } else {
                    "json".to_string()
                };
                request.body = RequestTextOrJson::Text(body.to_string());
            }

            if node_type == "graphql" {
                if request.url.trim().is_empty() {
                    request.url =
                        as_str(item.get("graphql").and_then(|graphql| graphql.get("url")));
                }
                if request.method.trim().is_empty() {
                    request.method = as_str(
                        item.get("graphql")
                            .and_then(|graphql| graphql.get("method")),
                    )
                    .to_uppercase();
                }
                if request.method.trim().is_empty() {
                    request.method = "POST".to_string();
                }
            }

            requests.push(request);
        }
    }

    let items = value
        .get("requests")
        .and_then(|v| v.as_array())
        .or_else(|| {
            value
                .get("collection")
                .and_then(|v| v.get("requests"))
                .and_then(|v| v.as_array())
        })
        .or_else(|| value.get("items").and_then(|v| v.as_array()))
        .or_else(|| value.get("item").and_then(|v| v.as_array()));

    if let Some(items) = items {
        collect_bruno_items(items, "", &mut folders, &mut requests);
    }

    CollectionRecord {
        name,
        folders: folders.into_iter().collect(),
        folder_settings: vec![],
        requests,
    }
}

trait IfEmptyThen {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String;
}

impl IfEmptyThen for String {
    fn if_empty_then<F: FnOnce() -> String>(self, fallback: F) -> String {
        if self.trim().is_empty() {
            fallback()
        } else {
            self
        }
    }
}

pub fn import_collection_value(value: &Value) -> Result<ImportedCollectionResult, String> {
    let detected_format = detect_format(value);
    let collection = match detected_format.as_str() {
        "kivo" => import_kivo(value)?,
        "postman" => {
            let mut requests = vec![];
            let mut folders = BTreeSet::new();
            if let Some(items) = value.get("item").and_then(|v| v.as_array()) {
                import_postman_items(items, "", &mut requests, &mut folders);
            }
            CollectionRecord {
                name: value
                    .get("info")
                    .and_then(|v| v.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Postman Import")
                    .to_string(),
                folders: folders.into_iter().collect(),
                folder_settings: vec![],
                requests,
            }
        }
        "openapi3" => import_openapi_like(value, "openapi3"),
        "swagger2" => import_openapi_like(value, "swagger2"),
        "bruno" => import_bruno(value),
        _ => {
            if let Ok(collection) = import_kivo(value) {
                return Ok(ImportedCollectionResult {
                    detected_format: "kivo".to_string(),
                    collection,
                });
            }
            return Err(
                "Unsupported collection format. Use Kivo JSON, Postman, OpenAPI 3, Swagger 2, or Bruno.".to_string(),
            )
        }
    };

    Ok(ImportedCollectionResult {
        detected_format,
        collection,
    })
}

pub fn parse_collection_content(content: &str) -> Result<ImportedCollectionResult, String> {
    if let Ok(json) = serde_json::from_str::<Value>(content) {
        return import_collection_value(&json);
    }

    let yaml = serde_yaml::from_str::<serde_yaml::Value>(content)
        .map_err(|_| "Unable to parse file as JSON or YAML.".to_string())?;
    let json_value =
        serde_json::to_value(yaml).map_err(|e| format!("Unable to convert YAML value: {e}"))?;
    import_collection_value(&json_value)
}
