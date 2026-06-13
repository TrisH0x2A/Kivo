use std::fs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::io::Write;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::{Command, Stdio};

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
const PROTECTED_SEED_PREFIX: &str = "dpapi:v1:";
#[cfg(target_os = "macos")]
const KEYCHAIN_SEED_MARKER: &str = "keychain:v1:com.kivo.desktop.auth-seed";
#[cfg(target_os = "linux")]
const SECRET_SERVICE_SEED_MARKER: &str = "secret-service:v1:kivo-auth-seed";

#[cfg(windows)]
fn protect_seed(seed: &str) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input = seed.as_bytes().to_vec();
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_mut_ptr(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("Failed to protect auth secret seed with Windows DPAPI.".to_string());
    }

    let bytes = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    unsafe {
        LocalFree(out_blob.pbData.cast());
    }
    Ok(format!("{PROTECTED_SEED_PREFIX}{encoded}"))
}

#[cfg(windows)]
fn unprotect_seed(value: &str) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let payload = value
        .strip_prefix(PROTECTED_SEED_PREFIX)
        .ok_or_else(|| "Auth secret seed is not DPAPI protected.".to_string())?;
    let mut cipher = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| format!("Failed to decode protected auth secret seed: {e}"))?;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_mut_ptr(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 {
        return Err("Failed to unprotect auth secret seed with Windows DPAPI.".to_string());
    }

    let bytes = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let seed = String::from_utf8(bytes.to_vec()).unwrap_or_default();
    unsafe {
        LocalFree(out_blob.pbData.cast());
    }
    Ok(seed)
}

#[cfg(target_os = "macos")]
fn protect_seed(seed: &str) -> Result<String, String> {
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            "Kivo",
            "-s",
            "com.kivo.desktop.auth-seed",
            "-w",
            seed,
        ])
        .output()
        .map_err(|e| format!("Failed to open macOS Keychain: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to protect auth seed with macOS Keychain: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(KEYCHAIN_SEED_MARKER.to_string())
}

#[cfg(target_os = "macos")]
fn unprotect_seed(value: &str) -> Result<String, String> {
    if value != KEYCHAIN_SEED_MARKER {
        return Err("Auth secret seed is not stored in macOS Keychain.".to_string());
    }
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "Kivo",
            "-s",
            "com.kivo.desktop.auth-seed",
            "-w",
        ])
        .output()
        .map_err(|e| format!("Failed to read macOS Keychain: {e}"))?;
    if !output.status.success() {
        return Err("Kivo auth seed was not found in macOS Keychain.".to_string());
    }
    String::from_utf8(output.stdout)
        .map(|seed| seed.trim().to_string())
        .map_err(|e| format!("macOS Keychain returned invalid text: {e}"))
}

#[cfg(target_os = "linux")]
fn protect_seed(seed: &str) -> Result<String, String> {
    let mut child = Command::new("secret-tool")
        .args([
            "store",
            "--label=Kivo authentication vault",
            "application",
            "kivo",
            "purpose",
            "auth-seed",
        ])
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("Failed to open Linux Secret Service (install libsecret-tools): {e}")
        })?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "Failed to open Linux Secret Service input.".to_string())?
        .write_all(seed.as_bytes())
        .map_err(|e| format!("Failed to write auth seed to Linux Secret Service: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to store auth seed in Linux Secret Service: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to protect auth seed with Linux Secret Service: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(SECRET_SERVICE_SEED_MARKER.to_string())
}

#[cfg(target_os = "linux")]
fn unprotect_seed(value: &str) -> Result<String, String> {
    if value != SECRET_SERVICE_SEED_MARKER {
        return Err("Auth secret seed is not stored in Linux Secret Service.".to_string());
    }
    let output = Command::new("secret-tool")
        .args(["lookup", "application", "kivo", "purpose", "auth-seed"])
        .output()
        .map_err(|e| format!("Failed to read Linux Secret Service: {e}"))?;
    if !output.status.success() || output.stdout.is_empty() {
        return Err("Kivo auth seed was not found in Linux Secret Service.".to_string());
    }
    String::from_utf8(output.stdout)
        .map(|seed| seed.trim().to_string())
        .map_err(|e| format!("Linux Secret Service returned invalid text: {e}"))
}

fn is_protected_seed(value: &str) -> bool {
    value.starts_with(PROTECTED_SEED_PREFIX)
        || cfg!(target_os = "macos") && value.starts_with("keychain:v1:")
        || cfg!(target_os = "linux") && value.starts_with("secret-service:v1:")
}

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
            if is_protected_seed(trimmed) {
                return unprotect_seed(trimmed);
            }

            let protected = protect_seed(trimmed)?;
            if protected != trimmed {
                fs::write(&secret_path, protected)
                    .map_err(|e| format!("Failed to migrate auth secret seed: {e}"))?;
            }
            return Ok(trimmed.to_string());
        }
    }

    let seed = format!("{}{}{}", Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    fs::write(&secret_path, protect_seed(&seed)?)
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
