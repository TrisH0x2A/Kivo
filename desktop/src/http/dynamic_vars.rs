use chrono::Utc;
use std::collections::HashMap;
use uuid::Uuid;

fn resolve_dynamic_variable(name: &str) -> Option<String> {
    match name {
        "$uuid" => Some(Uuid::new_v4().to_string()),
        "$timestamp" => Some(Utc::now().timestamp().to_string()),
        _ => None,
    }
}

pub fn resolve_template_variables(input: &str, vars: &HashMap<String, String>) -> String {
    let mut normalized_vars: HashMap<String, &String> = HashMap::new();
    for (key, value) in vars {
        normalized_vars
            .entry(key.trim().to_ascii_lowercase())
            .or_insert(value);
    }

    let mut out = String::with_capacity(input.len());
    let mut cursor = 0usize;

    while let Some(open_rel) = input[cursor..].find("{{") {
        let open = cursor + open_rel;
        out.push_str(&input[cursor..open]);

        let after_open = open + 2;
        let Some(close_rel) = input[after_open..].find("}}") else {
            out.push_str(&input[open..]);
            return out;
        };

        let close = after_open + close_rel;
        let raw_key = &input[after_open..close];
        let key = raw_key.trim();

        if let Some(value) = vars.get(key) {
            out.push_str(value);
        } else if let Some(value) = normalized_vars.get(&key.to_ascii_lowercase()) {
            out.push_str(value);
        } else if let Some(value) = resolve_dynamic_variable(key) {
            out.push_str(&value);
        } else {
            out.push_str("{{");
            out.push_str(raw_key);
            out.push_str("}}");
        }

        cursor = close + 2;
    }

    out.push_str(&input[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_env_and_dynamic_placeholders() {
        let mut vars = HashMap::new();
        vars.insert("HOST".to_string(), "api.example.com".to_string());

        let out = resolve_template_variables("https://{{HOST}}/{{$uuid}}/{{$timestamp}}", &vars);
        assert!(out.starts_with("https://api.example.com/"));

        let parts: Vec<&str> = out.split('/').collect();
        let uuid_part = parts[3];
        let ts_part = parts[4];

        assert_eq!(uuid_part.len(), 36);
        assert!(uuid_part.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert!(ts_part.parse::<i64>().is_ok());
    }

    #[test]
    fn unknown_placeholders_are_preserved() {
        let out = resolve_template_variables("{{MISSING}}/{{$unknown}}", &HashMap::new());
        assert_eq!(out, "{{MISSING}}/{{$unknown}}");
    }

    #[test]
    fn resolves_env_keys_case_insensitively() {
        let mut vars = HashMap::new();
        vars.insert("base_url".to_string(), "postman-echo.com".to_string());

        let out = resolve_template_variables("https://{{BASE_URL}}/get", &vars);
        assert_eq!(out, "https://postman-echo.com/get");
    }
}
