// Async vault dump/undump, moved off the Node sidecar so archiving never blocks
// the event loop. Wire-compatible with server/vault.js: scrypt (N=16384, r=8,
// p=1) → 32-byte key, AES-256-GCM (12-byte IV, 16-byte tag). The `.enc` file
// holds ONLY the ciphertext; salt/iv/tag travel in the meta JSON that Node still
// owns. `aes-gcm` appends the tag to the ciphertext, so we split it off on
// encrypt and re-join it on decrypt to match the Node layout exactly.
//
// Each database is its own encrypted unit (the `dbs` list), so per-package DBs
// can be packaged and encrypted individually rather than as one monolithic blob.
//
// The derived key is cached in the native process (see VaultKey in main.rs), so
// lock and checkpoint reuse it without the password ever transiting the webview.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const KEY_LEN: usize = 32;
const IV_LEN: usize = 12;
const SALT_LEN: usize = 32;
const TAG_LEN: usize = 16;
// N = 16384 = 2^14, r = 8, p = 1 — identical to server/vault.js SCRYPT_PARAMS.
const SCRYPT_LOG_N: u8 = 14;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

// ---- Request / response shapes exchanged with the frontend over Tauri IPC ----

#[derive(Deserialize)]
pub struct DbTarget {
    /// Plaintext DB file (read on dump, written on undump).
    pub plain_path: String,
    /// Encrypted counterpart on durable disk.
    pub enc_path: String,
}

#[derive(Serialize)]
pub struct EncMeta {
    pub iv: String,
    pub tag: String,
}

#[derive(Serialize)]
pub struct DbEncResult {
    pub enc_path: String,
    pub iv: String,
    pub tag: String,
}

#[derive(Serialize)]
pub struct DumpResult {
    /// The salt in use (freshly generated on first enable, echoed otherwise).
    pub salt_hex: String,
    pub dbs: Vec<DbEncResult>,
    pub sandboxes: Option<EncMeta>,
}

#[derive(Deserialize)]
pub struct DbUndumpTarget {
    pub enc_path: String,
    pub plain_path: String,
    pub iv: String,
    pub tag: String,
}

#[derive(Deserialize)]
pub struct SandboxUndumpTarget {
    pub enc_path: String,
    pub dir: String,
    pub iv: String,
    pub tag: String,
}

// ---- Key derivation & random material ----

pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let params = Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN)
        .map_err(|e| format!("scrypt params: {e}"))?;
    let mut key = [0u8; KEY_LEN];
    scrypt(password.as_bytes(), salt, &params, &mut key).map_err(|e| format!("scrypt: {e}"))?;
    Ok(key)
}

pub fn random_salt_hex() -> Result<String, String> {
    Ok(hex::encode(random_bytes(SALT_LEN)?))
}

fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).map_err(|e| format!("getrandom: {e}"))?;
    Ok(buf)
}

// ---- Core AES-256-GCM (tag split out to match server/vault.js layout) ----

fn encrypt(key: &[u8; KEY_LEN], plain: &[u8]) -> Result<(Vec<u8>, String, String), String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let iv = random_bytes(IV_LEN)?;
    let nonce = Nonce::from_slice(&iv);
    let mut sealed = cipher
        .encrypt(nonce, Payload { msg: plain, aad: &[] })
        .map_err(|_| "AES-GCM encrypt failed".to_string())?;
    if sealed.len() < TAG_LEN {
        return Err("ciphertext shorter than auth tag".into());
    }
    let tag = sealed.split_off(sealed.len() - TAG_LEN);
    Ok((sealed, hex::encode(iv), hex::encode(tag)))
}

fn decrypt(
    key: &[u8; KEY_LEN],
    ciphertext: &[u8],
    iv_hex: &str,
    tag_hex: &str,
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let iv = hex::decode(iv_hex).map_err(|e| format!("iv hex: {e}"))?;
    let tag = hex::decode(tag_hex).map_err(|e| format!("tag hex: {e}"))?;
    let nonce = Nonce::from_slice(&iv);
    let mut sealed = Vec::with_capacity(ciphertext.len() + tag.len());
    sealed.extend_from_slice(ciphertext);
    sealed.extend_from_slice(&tag);
    cipher
        .decrypt(nonce, Payload { msg: &sealed, aad: &[] })
        .map_err(|_| "Password errata o archivio manomesso.".to_string())
}

// ---- Sandbox tree packing (mirrors _packSandboxes / _unpackSandboxes) ----

#[derive(Serialize, Deserialize)]
struct PackedFile {
    path: String,
    data: String, // base64
    #[serde(default = "default_mode")]
    mode: u32,
}

fn default_mode() -> u32 {
    0o644
}

fn collect_files(base: &Path, dir: &Path, out: &mut Vec<PackedFile>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("dir entry: {e}"))?;
        let full = entry.path();
        let file_type = entry.file_type().map_err(|e| format!("file_type: {e}"))?;
        if file_type.is_dir() {
            collect_files(base, &full, out)?;
        } else if file_type.is_file() {
            let rel = full
                .strip_prefix(base)
                .map_err(|e| format!("strip_prefix: {e}"))?
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = std::fs::read(&full).map_err(|e| format!("read {}: {e}", full.display()))?;
            out.push(PackedFile {
                path: rel,
                data: B64.encode(&bytes),
                mode: file_mode(&full),
            });
        }
    }
    Ok(())
}

#[cfg(unix)]
fn file_mode(p: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.permissions().mode())
        .unwrap_or(0o644)
}

#[cfg(not(unix))]
fn file_mode(_p: &Path) -> u32 {
    0o644
}

fn pack_sandboxes(dir: &Path) -> Result<Vec<u8>, String> {
    let mut files = Vec::new();
    if dir.exists() {
        collect_files(dir, dir, &mut files)?;
    }
    let json = serde_json::to_vec(&files).map_err(|e| format!("pack json: {e}"))?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&json).map_err(|e| format!("gzip: {e}"))?;
    encoder.finish().map_err(|e| format!("gzip finish: {e}"))
}

fn unpack_sandboxes(dir: &Path, compressed: &[u8]) -> Result<(), String> {
    if compressed.is_empty() {
        return Ok(());
    }
    let mut decoder = GzDecoder::new(compressed);
    let mut json = Vec::new();
    decoder.read_to_end(&mut json).map_err(|e| format!("gunzip: {e}"))?;
    let files: Vec<PackedFile> =
        serde_json::from_slice(&json).map_err(|e| format!("unpack json: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    for f in files {
        let dest: PathBuf = dir.join(&f.path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let bytes = B64.decode(&f.data).map_err(|e| format!("b64 decode: {e}"))?;
        std::fs::write(&dest, &bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
        set_mode(&dest, f.mode);
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_p: &Path, _mode: u32) {}

// ---- Public entry points, keyed by an already-derived session key ----

pub fn dump(
    key: &[u8; KEY_LEN],
    salt_hex: String,
    dbs: &[DbTarget],
    sandboxes: Option<(&str, &str)>, // (dir, enc_path)
) -> Result<DumpResult, String> {
    let mut db_results = Vec::with_capacity(dbs.len());
    for db in dbs {
        let plain = std::fs::read(&db.plain_path).unwrap_or_default();
        let (ct, iv, tag) = encrypt(key, &plain)?;
        std::fs::write(&db.enc_path, &ct).map_err(|e| format!("write {}: {e}", db.enc_path))?;
        db_results.push(DbEncResult {
            enc_path: db.enc_path.clone(),
            iv,
            tag,
        });
    }

    let sandboxes = match sandboxes {
        Some((dir, enc_path)) => {
            let packed = pack_sandboxes(Path::new(dir))?;
            let (ct, iv, tag) = encrypt(key, &packed)?;
            std::fs::write(enc_path, &ct).map_err(|e| format!("write {enc_path}: {e}"))?;
            Some(EncMeta { iv, tag })
        }
        None => None,
    };

    Ok(DumpResult {
        salt_hex,
        dbs: db_results,
        sandboxes,
    })
}

pub fn undump(
    key: &[u8; KEY_LEN],
    dbs: &[DbUndumpTarget],
    sandboxes: Option<&SandboxUndumpTarget>,
) -> Result<(), String> {
    for db in dbs {
        let ct = std::fs::read(&db.enc_path).map_err(|e| format!("read {}: {e}", db.enc_path))?;
        let plain = decrypt(key, &ct, &db.iv, &db.tag)?;
        std::fs::write(&db.plain_path, &plain).map_err(|e| format!("write {}: {e}", db.plain_path))?;
    }

    if let Some(sb) = sandboxes {
        let ct = std::fs::read(&sb.enc_path).map_err(|e| format!("read {}: {e}", sb.enc_path))?;
        let plain = decrypt(key, &ct, &sb.iv, &sb.tag)?;
        unpack_sandboxes(Path::new(&sb.dir), &plain)?;
    }

    Ok(())
}
