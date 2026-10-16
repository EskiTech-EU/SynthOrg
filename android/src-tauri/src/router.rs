//! The I2P router the phone reaches the computer through.
//!
//! On Android it is i2pd, built into the app (native/i2pd) and run inside its
//! process: it starts with the app and stops with it. Only its SAM interface
//! is on, on the loopback, at a port chosen free at every start; the web
//! console, the proxies and UPnP are off.
//!
//! An external router can be used instead (its SAM address in the settings):
//! then the app starts nothing. It is also the only kind on a computer, where
//! this app runs only to try the interface.

use crate::store::Store;
use std::path::Path;

include!(concat!(env!("OUT_DIR"), "/certificates.rs"));

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RouterSettings {
    /// "embedded" or "external".
    pub mode: String,
    pub host: String,
    pub port: u16,
}

impl Default for RouterSettings {
    fn default() -> Self {
        RouterSettings { mode: if cfg!(target_os = "android") { "embedded" } else { "external" }.into(), host: "127.0.0.1".into(), port: 7656 }
    }
}

pub fn settings(store: &Store) -> RouterSettings {
    store.get("router").and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// Where SAM answers: the embedded router is started for it when that is the one chosen.
pub fn start(store: &Store, data_dir: &Path) -> Result<(String, u16), String> {
    let settings = settings(store);
    if settings.mode != "embedded" {
        return Ok((settings.host, settings.port));
    }
    // i2pd reads its options once per process: the SAM port chosen the first time is kept.
    let port = store.get("sam_port").and_then(|p| p.parse::<u16>().ok());
    let (host, port) = embedded::start(data_dir, port)?;
    store.set("sam_port", Some(&port.to_string()));
    Ok((host, port))
}

pub fn stop() {
    embedded::stop();
}

/// The phone has network, or has lost it: the router stops trying in the meantime.
#[allow(dead_code)]
pub fn network(online: bool) {
    embedded::network(online);
}

/// The certificates the router checks the reseed servers with, in its folder.
#[allow(dead_code)]
fn place_certificates(dir: &Path) -> std::io::Result<()> {
    for (name, bytes) in CERTIFICATES {
        let path = dir.join("certificates").join(name);
        if path.metadata().map(|m| m.len() == bytes.len() as u64).unwrap_or(false) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, bytes)?;
    }
    Ok(())
}

#[cfg(target_os = "android")]
mod embedded {
    use std::ffi::{CStr, CString, c_char, c_int};
    use std::path::Path;

    unsafe extern "C" {
        fn synthorg_i2pd_start_with_port(datadir: *const c_char, sam_port: c_int) -> c_int;
        fn synthorg_i2pd_stop();
        fn synthorg_i2pd_sam_port() -> c_int;
        fn synthorg_i2pd_network_changed(online: c_int);
        fn synthorg_i2pd_last_error() -> *const c_char;
    }

    pub fn start(data_dir: &Path, kept: Option<u16>) -> Result<(String, u16), String> {
        let running = unsafe { synthorg_i2pd_sam_port() };
        if running > 0 {
            return Ok(("127.0.0.1".into(), running as u16));
        }
        let dir = data_dir.join("i2pd");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cartella del router: {e}"))?;
        super::place_certificates(&dir).map_err(|e| format!("Certificati del router: {e}"))?;
        // A port free on the loopback, chosen once: another I2P app on the phone may hold the usual one.
        let port = match kept {
            Some(port) => port,
            None => std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| format!("Porta per il router: {e}"))?,
        };
        let path = CString::new(dir.to_string_lossy().as_bytes()).map_err(|_| "Cartella del router non valida".to_string())?;
        let code = unsafe { synthorg_i2pd_start_with_port(path.as_ptr(), port as c_int) };
        if code != 0 && code != 1 {
            let detail = unsafe { CStr::from_ptr(synthorg_i2pd_last_error()) }.to_string_lossy().into_owned();
            return Err(format!("Il router I2P non è partito ({code}): {detail}"));
        }
        let port = unsafe { synthorg_i2pd_sam_port() };
        if port <= 0 {
            return Err("Il router I2P è partito senza interfaccia SAM.".into());
        }
        Ok(("127.0.0.1".into(), port as u16))
    }

    pub fn stop() {
        unsafe { synthorg_i2pd_stop() };
    }

    pub fn network(online: bool) {
        unsafe { synthorg_i2pd_network_changed(online as c_int) };
    }
}

#[cfg(not(target_os = "android"))]
mod embedded {
    use std::path::Path;

    pub fn start(_: &Path, _: Option<u16>) -> Result<(String, u16), String> {
        Err("Su questo sistema il router I2P incorporato non c'è: scegliere un router esterno.".into())
    }

    pub fn stop() {}

    pub fn network(_: bool) {}
}
