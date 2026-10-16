use serde::Serialize;
use sidex_text::encoding::detect_encoding;
use sidex_text::Buffer;
use sidex_text::{detect_line_ending, line_ending_label};
use std::io::Read;

#[derive(Debug, Serialize)]
pub struct FileSummary {
    pub line_count: usize,
    pub word_count: usize,
    pub char_count: usize,
    pub has_bom: bool,
    pub likely_encoding: String,
    pub line_endings: String,
}

#[allow(clippy::needless_pass_by_value, clippy::large_stack_arrays)]
#[tauri::command]
pub fn count_lines(path: String) -> Result<usize, String> {
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut buf = [0u8; 32768];
    let mut count = 0usize;

    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Failed to read: {e}"))?;
        if n == 0 {
            break;
        }
        count += memchr::memchr_iter(b'\n', &buf[..n]).count();
    }

    Ok(count)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn file_summary(path: String) -> Result<FileSummary, String> {
    let content = std::fs::read(&path).map_err(|e| format!("Failed to read file: {e}"))?;

    let encoding = detect_encoding(&content);
    let has_bom = matches!(encoding, sidex_text::encoding::Encoding::Utf8Bom);

    let text_start = if has_bom { 3 } else { 0 };
    let text = String::from_utf8_lossy(&content[text_start..]);

    let buffer = Buffer::from_str(&text);
    let line_count = buffer.len_lines();
    let char_count = buffer.len_chars();

    let mut word_count = 0usize;
    for line_idx in 0..buffer.len_lines() {
        for word_info in buffer.words_at(line_idx) {
            if word_info.word_type == sidex_text::WordType::Word {
                word_count += 1;
            }
        }
    }

    let line_ending = detect_line_ending(&text);
    let line_endings = line_ending_label(line_ending).to_string();
    let likely_encoding = encoding.label().to_string();

    Ok(FileSummary {
        line_count,
        word_count,
        char_count,
        has_bom,
        likely_encoding,
        line_endings,
    })
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn trim_trailing_whitespace(text: String) -> String {
    let mut result = String::with_capacity(text.len());
    for (i, line) in text.lines().enumerate() {
        if i > 0 {
            result.push('\n');
        }
        result.push_str(line.trim_end());
    }
    result
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn file_hash(path: String) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let content = std::fs::read(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    Ok(format!("{:x}", hasher.finish()))
}

#[allow(clippy::needless_pass_by_value, clippy::large_stack_arrays)]
#[tauri::command]
pub fn files_equal(path1: String, path2: String) -> Result<bool, String> {
    let meta1 = std::fs::metadata(&path1).map_err(|e| format!("Failed to stat file 1: {e}"))?;
    let meta2 = std::fs::metadata(&path2).map_err(|e| format!("Failed to stat file 2: {e}"))?;

    if meta1.len() != meta2.len() {
        return Ok(false);
    }

    let mut f1 = std::fs::File::open(&path1).map_err(|e| format!("Failed to open file 1: {e}"))?;
    let mut f2 = std::fs::File::open(&path2).map_err(|e| format!("Failed to open file 2: {e}"))?;
    let mut buf1 = [0u8; 32768];
    let mut buf2 = [0u8; 32768];

    loop {
        let n1 = f1.read(&mut buf1).map_err(|e| format!("Read error: {e}"))?;
        let n2 = f2.read(&mut buf2).map_err(|e| format!("Read error: {e}"))?;
        if n1 != n2 || buf1[..n1] != buf2[..n2] {
            return Ok(false);
        }
        if n1 == 0 {
            return Ok(true);
        }
    }
}
