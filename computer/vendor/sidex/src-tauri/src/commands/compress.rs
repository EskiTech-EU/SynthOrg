use serde::Serialize;
use std::fs::File;
use std::io::Read;

const MAX_DECOMPRESSED_SIZE: u64 = 100 * 1024 * 1024; // 100 MB

#[derive(Debug, Serialize)]
pub struct ZipEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub modified: Option<String>,
}

/// List contents of a zip file
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn zip_list(path: String) -> Result<Vec<ZipEntry>, String> {
    let file = File::open(&path).map_err(|e| format!("Failed to open zip: {e}"))?;

    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {e}"))?;

    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry: {e}"))?;

        entries.push(ZipEntry {
            name: file.name().to_string(),
            size: file.size(),
            is_dir: file.is_dir(),
            modified: None, // Simplified - zip datetime handling is complex
        });
    }

    Ok(entries)
}

/// Extract single file from zip
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn zip_extract_file(zip_path: String, entry_name: String) -> Result<Vec<u8>, String> {
    if entry_name.contains("..") || entry_name.starts_with('/') || entry_name.starts_with('\\') {
        return Err("Invalid zip entry name: must not contain '..' or start with '/'".to_string());
    }

    let file = File::open(&zip_path).map_err(|e| format!("Failed to open zip: {e}"))?;

    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {e}"))?;

    let entry = archive
        .by_name(&entry_name)
        .map_err(|e| format!("Entry not found: {e}"))?;

    let entry_size = entry.size();
    if entry_size > MAX_DECOMPRESSED_SIZE {
        return Err(format!(
            "Zip entry too large: {entry_size} bytes (limit: {MAX_DECOMPRESSED_SIZE} bytes)"
        ));
    }

    let mut limited = entry.take(MAX_DECOMPRESSED_SIZE + 1);
    let mut result = Vec::with_capacity(entry_size.min(MAX_DECOMPRESSED_SIZE) as usize);
    limited
        .read_to_end(&mut result)
        .map_err(|e| format!("Failed to read entry: {e}"))?;

    Ok(result)
}

/// Compress directory to zip
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn zip_create(source_dir: String, zip_path: String) -> Result<(), String> {
    let file = File::create(&zip_path).map_err(|e| format!("Failed to create zip: {e}"))?;

    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let walkdir = walkdir::WalkDir::new(&source_dir);
    let source_path = std::path::Path::new(&source_dir);

    for entry in walkdir.into_iter().filter_map(std::result::Result::ok) {
        let path = entry.path();
        let name = path
            .strip_prefix(source_path)
            .map_err(|e| format!("Path error: {e}"))?
            .to_string_lossy();

        if path.is_file() {
            zip.start_file(name, options)
                .map_err(|e| format!("Failed to start file: {e}"))?;

            let mut f = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
            std::io::copy(&mut f, &mut zip).map_err(|e| format!("Failed to write to zip: {e}"))?;
        } else if !name.is_empty() {
            zip.add_directory(name, options)
                .map_err(|e| format!("Failed to add directory: {e}"))?;
        }
    }

    zip.finish()
        .map_err(|e| format!("Failed to finish zip: {e}"))?;

    Ok(())
}
