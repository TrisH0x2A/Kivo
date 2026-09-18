use std::fs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::io::Write;
use std::path::Path;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::process::{Command, Stdio};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use super::AppSettings;

const AUTH_ENCRYPTION_PREFIX: &str = "enc:v1:";
static SEED_LOCK: Mutex<()> = Mutex::new(());
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
        || value.starts_with("keychain:v1:")
        || value.starts_with("secret-service:v1:")
}

#[tauri::command]
pub fn get_or_create_auth_secret_seed(app: AppHandle) -> Result<String, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create app data directory: {e}"))?;

    read_or_create_seed(
        &app_dir.join("auth-secret.seed"),
        protect_seed,
        unprotect_seed,
    )
}

fn read_or_create_seed(
    secret_path: &Path,
    protect: impl Fn(&str) -> Result<String, String>,
    unprotect: impl Fn(&str) -> Result<String, String>,
) -> Result<String, String> {
    let _guard = SEED_LOCK
        .lock()
        .map_err(|_| "Secure storage is unavailable. Restart Kivo to retry.".to_string())?;
    if secret_path.exists() {
        let seed = fs::read_to_string(secret_path)
            .map_err(|e| format!("Failed to read auth secret seed: {e}"))?;
        let trimmed = seed.trim();
        if !trimmed.is_empty() {
            if is_protected_seed(trimmed) {
                let seed = unprotect(trimmed)?;
                if seed.trim().is_empty() {
                    return Err("Secure storage returned an empty auth seed".to_string());
                }
                return Ok(seed);
            }

            let protected = protect(trimmed)?;
            if protected != trimmed {
                super::durable::atomic_write(secret_path, protected)?;
            }
            return Ok(trimmed.to_string());
        }
        return Err(
            "Auth secret seed is empty. Restore the original vault seed before continuing."
                .to_string(),
        );
    }

    let seed = format!("{}{}{}", Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    super::durable::atomic_write(secret_path, protect(&seed)?)?;
    Ok(seed)
}

pub(crate) fn encrypt_sensitive_text_with_seed(value: &str, seed: &str) -> Result<String, String> {
    if seed.trim().is_empty() {
        return Err("Secure storage key is unavailable".to_string());
    }
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(
        seed.as_bytes(),
        AUTH_ENCRYPTION_SALT,
        AUTH_ENCRYPTION_ITERATIONS,
        &mut key,
    );
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| "Cannot initialize encryption".to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(&nonce, value.as_bytes())
        .map_err(|_| "Cannot encrypt private data".to_string())?;
    Ok(format!(
        "{AUTH_ENCRYPTION_PREFIX}{}:{}",
        base64::engine::general_purpose::STANDARD.encode(nonce),
        base64::engine::general_purpose::STANDARD.encode(encrypted)
    ))
}

pub(crate) fn decrypt_sensitive_text_with_seed(value: &str, seed: &str) -> Result<String, String> {
    if !value.starts_with(AUTH_ENCRYPTION_PREFIX) {
        return Ok(value.to_string());
    }
    let failure = || {
        "A saved credential could not be decrypted. Restore access to the original keychain before continuing.".to_string()
    };
    if seed.trim().is_empty() {
        return Err(failure());
    }

    let payload = &value[AUTH_ENCRYPTION_PREFIX.len()..];
    let (iv_b64, cipher_b64) = payload.split_once(':').ok_or_else(failure)?;
    let iv = base64::engine::general_purpose::STANDARD
        .decode(iv_b64)
        .map_err(|_| failure())?;
    let cipher_text = base64::engine::general_purpose::STANDARD
        .decode(cipher_b64)
        .map_err(|_| failure())?;
    if iv.len() != 12 || cipher_text.len() < 16 {
        return Err(failure());
    }

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(
        seed.as_bytes(),
        AUTH_ENCRYPTION_SALT,
        AUTH_ENCRYPTION_ITERATIONS,
        &mut key,
    );

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| failure())?;
    let nonce = Nonce::from_slice(&iv);
    let plain = cipher
        .decrypt(nonce, cipher_text.as_ref())
        .map_err(|_| failure())?;
    String::from_utf8(plain).map_err(|_| failure())
}

pub fn decrypt_app_settings_for_runtime(
    app: &AppHandle,
    settings: &mut AppSettings,
) -> Result<(), String> {
    if ![
        &settings.proxy_password,
        &settings.custom_ca_certificate_path,
        &settings.client_certificate_path,
        &settings.client_key_path,
    ]
    .iter()
    .any(|value| value.starts_with(AUTH_ENCRYPTION_PREFIX))
    {
        return Ok(());
    }
    let seed = get_or_create_auth_secret_seed(app.clone())?;
    let proxy = decrypt_sensitive_text_with_seed(&settings.proxy_password, &seed)?;
    let ca = decrypt_sensitive_text_with_seed(&settings.custom_ca_certificate_path, &seed)?;
    let certificate = decrypt_sensitive_text_with_seed(&settings.client_certificate_path, &seed)?;
    let key = decrypt_sensitive_text_with_seed(&settings.client_key_path, &seed)?;
    settings.proxy_password = proxy;
    settings.custom_ca_certificate_path = ca;
    settings.client_certificate_path = certificate;
    settings.client_key_path = key;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn unavailable_vault_does_not_write_a_plaintext_seed() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("auth-secret.seed");
        assert!(read_or_create_seed(&path, |_| Err("locked".into()), |_| unreachable!()).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn empty_or_locked_vault_is_not_replaced() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("auth-secret.seed");
        for content in ["", "dpapi:v1:synthetic-protected-value"] {
            fs::write(&path, content).unwrap();
            assert!(read_or_create_seed(
                &path,
                |_| panic!("must not replace seed"),
                |_| Err("locked".into())
            )
            .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
        }
    }

    #[test]
    fn legacy_seed_is_only_replaced_after_successful_protection() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("auth-secret.seed");
        fs::write(&path, "synthetic-legacy-seed").unwrap();
        assert!(read_or_create_seed(&path, |_| Err("locked".into()), |_| unreachable!()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "synthetic-legacy-seed");
        assert_eq!(
            read_or_create_seed(
                &path,
                |_| Ok("dpapi:v1:synthetic".into()),
                |_| unreachable!()
            )
            .unwrap(),
            "synthetic-legacy-seed"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "dpapi:v1:synthetic");
    }

    #[test]
    fn malformed_ciphertext_is_an_error_not_an_empty_secret() {
        for value in [
            "enc:v1:",
            "enc:v1:bad:data",
            "enc:v1:AAAAAAAAAAAAAAAA:bad",
            "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==",
        ] {
            assert!(decrypt_sensitive_text_with_seed(value, "synthetic-seed").is_err());
        }
        assert_eq!(
            decrypt_sensitive_text_with_seed("legacy", "").unwrap(),
            "legacy"
        );
    }

    #[test]
    fn authenticated_ciphertext_roundtrips_and_rejects_wrong_key() {
        let seed = "synthetic-seed";
        let mut key = [0u8; 32];
        pbkdf2_hmac::<Sha256>(
            seed.as_bytes(),
            AUTH_ENCRYPTION_SALT,
            AUTH_ENCRYPTION_ITERATIONS,
            &mut key,
        );
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let iv = [7u8; 12];
        let encrypted = cipher
            .encrypt(Nonce::from_slice(&iv), b"synthetic-token".as_ref())
            .unwrap();
        let value = format!(
            "enc:v1:{}:{}",
            base64::engine::general_purpose::STANDARD.encode(iv),
            base64::engine::general_purpose::STANDARD.encode(encrypted)
        );
        assert_eq!(
            decrypt_sensitive_text_with_seed(&value, seed).unwrap(),
            "synthetic-token"
        );
        assert!(decrypt_sensitive_text_with_seed(&value, "wrong-key").is_err());
        assert_eq!(
            value,
            "enc:v1:BwcHBwcHBwcHBwcH:HwpAEswax305AYS/i8m2T2Dp8W5/YFLwT5OkFj+eoQ=="
        );
    }

    #[test]
    fn concurrent_seed_requests_share_one_persisted_seed() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("auth-secret.seed");
        let handles = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    read_or_create_seed(
                        &path,
                        |seed| Ok(format!("dpapi:v1:{seed}")),
                        |value| Ok(value.strip_prefix("dpapi:v1:").unwrap().to_string()),
                    )
                    .unwrap()
                })
            })
            .collect::<Vec<_>>();
        let seeds = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert!(seeds.iter().all(|seed| seed == &seeds[0]));
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            format!("dpapi:v1:{}", seeds[0])
        );
    }
}
