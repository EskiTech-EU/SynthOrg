//! The archive, where the page looks for it.
//!
//! The interface reads and writes the archive at `<origin>/api/...`, as it
//! does on the computer with the local service. Here the origin is this
//! app's own scheme (`http://synthorg.localhost` in the webview): only the
//! webview reaches it, no other app on the phone.
//!
//! A request is answered by the phone's own archive (archive.rs), at once:
//! the chats, the assistant's pages, the settings are here, and what is
//! written is written here. What it wrote goes to the computer after
//! (link.rs).
//!
//! What only the computer has (the container and the files of a chat, the
//! Code projects) is asked of the computer through the bridge (`api`,
//! computer/server/bridge-api.js). A reading of those the phone has a copy of
//! is answered from the copy at once and checked after, together with the
//! others (link.rs, `refresh`). Without a computer paired, or while it cannot
//! be reached, those requests say so.

use crate::link::Link;
use crate::store::Kept;
use serde_json::{Value, json};
use std::sync::Arc;
use tauri::http::{Request, Response, StatusCode};

fn answer(status: u16, content_type: &str, body: Vec<u8>, extra: &[(&str, String)]) -> Response<Vec<u8>> {
    let mut response = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY))
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Disposition, X-Synthorg-Copy");
    for (name, value) in extra {
        response = response.header(*name, value);
    }
    response.body(body).unwrap_or_else(|_| Response::new(Vec::new()))
}

fn json_answer(status: u16, value: &Value, extra: &[(&str, String)]) -> Response<Vec<u8>> {
    answer(status, "application/json; charset=utf-8", serde_json::to_vec(value).unwrap_or_default(), extra)
}

fn error(status: u16, message: &str) -> Response<Vec<u8>> {
    json_answer(status, &json!({ "error": message }), &[])
}

fn segments(path: &str) -> Vec<&str> {
    path.trim_start_matches('/').split('/').filter(|s| !s.is_empty()).collect()
}

/// What the phone answers by itself, without the archive: that the service is there, and that nothing here is locked.
fn fixed(method: &str, parts: &[&str]) -> Option<Response<Vec<u8>>> {
    match (method, parts) {
        ("GET", ["api", "health"]) => Some(json_answer(200, &json!({ "app": "synthorg-storage", "version": 10, "instance": "phone" }), &[])),
        // The vault is the computer's: the phone's archive is in the app's private folder, which the system keeps from the other apps.
        ("GET", ["api", "security"]) => Some(json_answer(
            200,
            &json!({
                "isEncrypted": false, "isUnlocked": true, "targets": { "sql": false, "sandboxes": false },
                "sql": { "isEncrypted": false, "isUnlocked": true }, "sandboxes": { "isEncrypted": false, "isUnlocked": true }, "encryptedAt": null
            }),
            &[],
        )),
        (_, ["api", "security", ..]) | (_, ["api", "bridge", ..]) | (_, ["api", "shutdown"]) | (_, ["api", "changes"]) => Some(error(403, "Questo si fa dal computer.")),
        _ => None,
    }
}

pub async fn handle(link: Arc<Link>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let method = request.method().as_str().to_uppercase();
    if method == "OPTIONS" {
        return Response::builder()
            .status(204)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            .header("Access-Control-Allow-Headers", "Content-Type, Authorization, Range")
            .header("Access-Control-Max-Age", "600")
            .body(Vec::new())
            .unwrap();
    }
    let uri = request.uri();
    let path = uri.path().to_string();
    let target = match uri.query() {
        Some(query) => format!("{path}?{query}"),
        None => path.clone(),
    };
    if !path.starts_with("/api/") {
        return error(404, "Non trovato.");
    }
    let parts = segments(&path);
    if let Some(response) = fixed(&method, &parts) {
        return response;
    }
    let body: Value = if request.body().is_empty() { Value::Null } else { serde_json::from_slice(request.body()).unwrap_or(Value::Null) };
    let paired = link.paired();

    // The phone's own archive.
    if let Some(answered) = link.archive.request(&method, &path, uri.query(), body.clone()).await {
        if method != "GET" && answered.status < 300 {
            link.written();
        }
        return json_answer(answered.status, &answered.data, &[]);
    }

    // The computer's.
    if !paired {
        return error(503, "Per questo serve un computer collegato.");
    }
    if method == "GET" {
        let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(str::to_string);
        return read(&link, &target, range).await;
    }
    write(&link, &method, &path, &target, body).await
}

async fn read(link: &Arc<Link>, target: &str, range: Option<String>) -> Response<Vec<u8>> {
    if range.is_none()
        && let Some(kept) = link.store.copy(target) {
            // Bytes (a picture, a file of a chat) do not change; the rest is checked, all at once.
            if kept.content_type.starts_with("application/json") && link.online() && !link.is_fresh(target) {
                link.refresh_soon();
            }
            return answer(kept.status, &kept.content_type, kept.body, &[("X-Synthorg-Copy", "1".into())]);
        }
    let mut params = json!({ "method": "GET", "path": target });
    if let Some(range) = &range {
        params["range"] = Value::String(range.clone());
    }
    match link.call("api", params, None).await {
        Ok((result, bytes)) => {
            let (status, content_type, body, extra) = unpack(&result, bytes);
            if status == 200 && range.is_none() {
                let tag = result.get("tag").and_then(Value::as_str).map(str::to_string);
                link.store.keep(target, &Kept { status, content_type: content_type.clone(), body: body.clone(), tag });
                link.mark_fresh(target);
            }
            answer(status, &content_type, body, &extra)
        }
        Err(refusal) if refusal.unreached() => error(503, "Per questo serve il collegamento con il computer."),
        Err(refusal) => error(502, &refusal.message),
    }
}

async fn write(link: &Arc<Link>, method: &str, path: &str, target: &str, body: Value) -> Response<Vec<u8>> {
    // What this phone wrote is there before what is asked now (a chat made here, before its container is set).
    link.flush().await;
    match link.call("api", json!({ "method": method, "path": target, "body": body }), None).await {
        Ok((result, bytes)) => {
            let (status, content_type, answered, extra) = unpack(&result, bytes);
            // The copies it makes old are let go of, and read again from the computer.
            link.store.forget_under(path);
            answer(status, &content_type, answered, &extra)
        }
        Err(refusal) if refusal.unreached() => error(503, "Per questo serve il collegamento con il computer."),
        Err(refusal) => error(502, &refusal.message),
    }
}

/// The answer of the computer's service, as the page reads it.
fn unpack(result: &Value, bytes: Vec<u8>) -> (u16, String, Vec<u8>, Vec<(&'static str, String)>) {
    let status = result.get("status").and_then(Value::as_u64).unwrap_or(502) as u16;
    let content_type = result.get("type").and_then(Value::as_str).unwrap_or("application/octet-stream").to_string();
    let mut extra = Vec::new();
    for (key, name) in [("content-range", "Content-Range"), ("content-disposition", "Content-Disposition"), ("accept-ranges", "Accept-Ranges")] {
        if let Some(value) = result.get(key).and_then(Value::as_str) {
            extra.push((name, value.to_string()));
        }
    }
    let body = match result.get("data") {
        Some(data) if content_type.starts_with("application/json") => serde_json::to_vec(data).unwrap_or_default(),
        _ => bytes,
    };
    (status, content_type, body, extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_phone_answers_without_the_archive() {
        assert!(fixed("GET", &segments("/api/health")).is_some());
        assert_eq!(fixed("GET", &segments("/api/security")).unwrap().status(), 200);
        assert_eq!(fixed("POST", &segments("/api/security/unlock")).unwrap().status(), 403);
        assert_eq!(fixed("GET", &segments("/api/bridge")).unwrap().status(), 403);
        assert!(fixed("GET", &segments("/api/settings")).is_none());
    }
}
