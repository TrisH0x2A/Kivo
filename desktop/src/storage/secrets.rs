use std::fs;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::AppSettings;

const AUTH_ENCRYPTION_PREFIX: &str = "enc:v1:";
const AUTH_ENCRYPTION_SALT: &[u8] = b"kivo-auth-encryption-salt-v1";
const AUTH_ENCRYPTION_ITERATIONS: u32 = 100_000;

#[tauri::command]
pub fn get_or_create_auth_secret_seed(app: AppHandle) -> Result<String, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    let secret_path = app_dir.join("auth-secret.seed");
    if secret_path.exists() {
        let seed = fs::read_to_string(&secret_path)
            .map_err(|e| format!("Failed to read auth secret seed: {e}"))?;
        let trimmed = seed.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let seed = format!("{}{}{}", Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    fs::write(&secret_path, &seed)
        .map_err(|e| format!("Failed to persist auth secret seed: {e}"))?;
    Ok(seed)
}

fn decrypt_sensitive_text_with_seed(value: &str, seed: &str) -> String {
    if !value.starts_with(AUTH_ENCRYPTION_PREFIX) || seed.trim().is_empty() {
        return value.to_string();
    }

    let payload = &value[AUTH_ENCRYPTION_PREFIX.len()..];
    let Some((iv_b64, cipher_b64)) = payload.split_once(':') else {
        return String::new();
    };

    let iv = match base64::engine::general_purpose::STANDARD.decode(iv_b64) {
        Ok(bytes) => bytes,
        Err(_) => return String::new(),
    };
    let cipher_text = match base64::engine::general_purpose::STANDARD.decode(cipher_b64) {
        Ok(bytes) => bytes,
        Err(_) => return String::new(),
    };
    if iv.len() != 12 {
        return String::new();
    }

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(
        seed.as_bytes(),
        AUTH_ENCRYPTION_SALT,
        AUTH_ENCRYPTION_ITERATIONS,
        &mut key,
    );

    let Ok(cipher) = Aes256Gcm::new_from_slice(&key) else {
        return String::new();
    };
    let nonce = Nonce::from_slice(&iv);
    match cipher.decrypt(nonce, cipher_text.as_ref()) {
        Ok(plain) => String::from_utf8(plain).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

pub fn decrypt_app_settings_for_runtime(app: &AppHandle, settings: &mut AppSettings) {
    let Ok(seed) = get_or_create_auth_secret_seed(app.clone()) else {
        return;
    };
    settings.proxy_password = decrypt_sensitive_text_with_seed(&settings.proxy_password, &seed);
    settings.custom_ca_certificate_path =
        decrypt_sensitive_text_with_seed(&settings.custom_ca_certificate_path, &seed);
    settings.client_certificate_path =
        decrypt_sensitive_text_with_seed(&settings.client_certificate_path, &seed);
    settings.client_key_path = decrypt_sensitive_text_with_seed(&settings.client_key_path, &seed);
}
