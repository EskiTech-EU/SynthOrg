//! The archive, on the phone.
//!
//! The phone keeps the archive whole (chats, the assistant's pages, the
//! settings) in its own SQLite, and runs on it the same rules as the
//! computer: the JavaScript files of computer/server, as they are, in QuickJS
//! (archive.js makes them at home). What is done on the phone is written
//! here, at once, by the phone; the rows that came out of it go to the
//! computer after, and the computer's come here (link.rs, replica.js).
//!
//! One thread owns the database and the engine; the rest of the app asks it
//! and waits for the answer.

use rquickjs::{Context, Ctx, Exception, Function, Runtime};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, params_from_iter};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use tokio::sync::oneshot;

/// The computer's files the archive is made of.
const SOURCES: &[(&str, &str)] = &[
    ("database", include_str!("../../../computer/server/database.js")),
    ("personal", include_str!("../../../computer/server/personal.js")),
    ("memory-tree", include_str!("../../../computer/server/memory-tree.js")),
    ("usage", include_str!("../../../computer/server/usage.js")),
    ("share-endpoint", include_str!("../../../computer/server/share-endpoint.js")),
    ("bridge-store", include_str!("../../../computer/server/bridge-store.js")),
    ("replica", include_str!("../../../computer/server/replica.js")),
    ("archive-api", include_str!("../../../computer/server/archive-api.js")),
];
const HOME: &str = include_str!("archive.js");

struct Job {
    name: &'static str,
    argument: String,
    reply: oneshot::Sender<Result<Value, Failure>>,
}

/// A call the archive could not answer.
#[derive(Debug, Clone)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}

/// The answer to a request of the page: `None` when it is not the archive's.
pub struct Answer {
    pub status: u16,
    pub data: Value,
}

pub struct Archive {
    jobs: mpsc::Sender<Job>,
}

impl Archive {
    /// Opens the archive at `path` and starts its thread. `recover`: see archive.js.
    pub fn open(path: &Path, recover: bool) -> Result<Self, String> {
        let (jobs, queue) = mpsc::channel::<Job>();
        let (ready, started) = mpsc::channel::<Result<(), String>>();
        let path: PathBuf = path.to_path_buf();
        std::thread::Builder::new()
            .name("archive".into())
            .stack_size(8 * 1024 * 1024)
            .spawn(move || run(&path, recover, queue, ready))
            .map_err(|e| e.to_string())?;
        started.recv().map_err(|_| "L'archivio non si è avviato.".to_string())??;
        Ok(Archive { jobs })
    }

    async fn call(&self, name: &'static str, argument: Value) -> Result<Value, Failure> {
        let (reply, answer) = oneshot::channel();
        self.jobs
            .send(Job { name, argument: argument.to_string(), reply })
            .map_err(|_| Failure { status: 503, message: "L'archivio non risponde.".into() })?;
        answer.await.map_err(|_| Failure { status: 503, message: "L'archivio non risponde.".into() })?
    }

    /// A request of the page (`/api/...`).
    pub async fn request(&self, method: &str, path: &str, query: Option<&str>, body: Value) -> Option<Answer> {
        let query = Value::Object(parse_query(query.unwrap_or("")));
        match self.call("request", json!({ "method": method, "path": path, "query": query, "body": body })).await {
            Ok(value) => {
                if value.get("handled").and_then(Value::as_bool) != Some(true) {
                    return None;
                }
                if let Some(detail) = value.get("detail").and_then(Value::as_str) {
                    eprintln!("[archive] {method} {path}: {detail}");
                }
                Some(Answer {
                    status: value.get("status").and_then(Value::as_u64).unwrap_or(500) as u16,
                    data: value.get("data").cloned().unwrap_or(Value::Null),
                })
            }
            Err(failure) => Some(Answer { status: failure.status, data: json!({ "error": failure.message }) }),
        }
    }

    /// What this phone has for the computer: `{ site, to, have, after, upto, more, rows }`.
    pub async fn offer(&self, peer: &str) -> Result<Value, Failure> {
        self.call("offer", json!({ "peer": peer })).await
    }

    /// The computer's rows, written here: `{ reset, gap, more, changes }`.
    pub async fn answered(&self, peer: &str, answer: Value) -> Result<Value, Failure> {
        self.call("answered", json!({ "peer": peer, "answer": answer })).await
    }

    /// How many rows wait to be sent to the computer.
    pub async fn waiting(&self, peer: &str) -> usize {
        self.call("waiting", json!({ "peer": peer })).await.ok().and_then(|v| v.get("rows").and_then(Value::as_u64)).unwrap_or(0) as usize
    }

    pub async fn forget(&self, peer: &str) {
        let _ = self.call("forget", json!({ "peer": peer })).await;
    }
}

/// The query string as the page wrote it, read into its values.
fn parse_query(query: &str) -> Map<String, Value> {
    let mut values = Map::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        values.insert(percent_decode(key), Value::String(percent_decode(value)));
    }
    values
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = ((bytes[i + 1] as char).to_digit(16), (bytes[i + 2] as char).to_digit(16)) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn bind(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(flag) => SqlValue::Integer(*flag as i64),
        Value::Number(number) => match number.as_i64() {
            Some(whole) => SqlValue::Integer(whole),
            None => SqlValue::Real(number.as_f64().unwrap_or(0.0)),
        },
        Value::String(text) => SqlValue::Text(text.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn column(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(whole) => Value::from(whole),
        ValueRef::Real(real) => serde_json::Number::from_f64(real).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(blob) => Value::String(blob.iter().map(|byte| format!("{byte:02x}")).collect()),
    }
}

fn arguments(text: &str) -> Vec<SqlValue> {
    serde_json::from_str::<Vec<Value>>(text).unwrap_or_default().iter().map(bind).collect()
}

/// Every row of a statement, as `[{ column: value }]`.
fn sql_all(db: &Connection, sql: &str, args: &str) -> rusqlite::Result<String> {
    let mut statement = db.prepare_cached(sql)?;
    let names: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
    let mut rows = statement.query(params_from_iter(arguments(args)))?;
    let mut all = Vec::new();
    while let Some(row) = rows.next()? {
        let mut item = Map::new();
        for (index, name) in names.iter().enumerate() {
            item.insert(name.clone(), column(row.get_ref(index)?));
        }
        all.push(Value::Object(item));
    }
    Ok(Value::Array(all).to_string())
}

/// A statement run to its end: `{ changes, lastInsertRowid }`.
fn sql_run(db: &Connection, sql: &str, args: &str) -> rusqlite::Result<String> {
    let mut statement = db.prepare_cached(sql)?;
    let mut rows = statement.query(params_from_iter(arguments(args)))?;
    while rows.next()?.is_some() {}
    drop(rows);
    drop(statement);
    Ok(json!({ "changes": db.changes(), "lastInsertRowid": db.last_insert_rowid() }).to_string())
}

fn thrown(ctx: &Ctx<'_>, error: rusqlite::Error) -> rquickjs::Error {
    Exception::throw_message(ctx, &error.to_string())
}

/// What a script threw, as text.
fn caught(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if !matches!(error, rquickjs::Error::Exception) {
        return error.to_string();
    }
    let value = ctx.catch();
    if let Some(exception) = value.as_exception() {
        return format!("{} {}", exception.message().unwrap_or_default(), exception.stack().unwrap_or_default());
    }
    format!("{value:?}")
}

fn set<'js>(ctx: &Ctx<'js>, name: &str, function: rquickjs::Result<Function<'js>>) -> Result<(), String> {
    ctx.globals().set(name, function.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn start(db: Rc<Connection>, context: &Context, recover: bool) -> Result<(), String> {
    context.with(|ctx| -> Result<(), String> {
        let handle = db.clone();
        set(&ctx, "__sql_exec", Function::new(ctx.clone(), move |ctx: Ctx<'_>, sql: String| -> rquickjs::Result<()> {
            handle.execute_batch(&sql).map_err(|error| thrown(&ctx, error))
        }))?;
        let handle = db.clone();
        set(&ctx, "__sql_all", Function::new(ctx.clone(), move |ctx: Ctx<'_>, sql: String, args: String| -> rquickjs::Result<String> {
            sql_all(&handle, &sql, &args).map_err(|error| thrown(&ctx, error))
        }))?;
        let handle = db.clone();
        set(&ctx, "__sql_run", Function::new(ctx.clone(), move |ctx: Ctx<'_>, sql: String, args: String| -> rquickjs::Result<String> {
            sql_run(&handle, &sql, &args).map_err(|error| thrown(&ctx, error))
        }))?;
        set(&ctx, "__random", Function::new(ctx.clone(), |ctx: Ctx<'_>, count: usize| -> rquickjs::Result<String> {
            let mut bytes = vec![0u8; count.min(1024)];
            getrandom::fill(&mut bytes).map_err(|error| Exception::throw_message(&ctx, &error.to_string()))?;
            Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
        }))?;
        set(&ctx, "__sha256", Function::new(ctx.clone(), |text: String| -> String {
            Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
        }))?;
        let mut sources = Map::new();
        for (name, source) in SOURCES {
            sources.insert((*name).to_string(), Value::String((*source).to_string()));
        }
        ctx.eval::<(), _>(format!("globalThis.__sources = {};", Value::Object(sources))).map_err(|error| caught(&ctx, error))?;
        ctx.eval::<(), _>(HOME).map_err(|error| caught(&ctx, error))?;
        let opened = call(&ctx, "open", &json!({ "recover": recover }).to_string());
        opened.map(|_| ()).map_err(|failure| failure.message)
    })
}

fn call(ctx: &Ctx<'_>, name: &str, argument: &str) -> Result<Value, Failure> {
    let broken = |message: String| Failure { status: 500, message };
    let function: Function = ctx.globals().get("__call").map_err(|error| broken(caught(ctx, error)))?;
    let text: String = function.call((name, argument)).map_err(|error| broken(caught(ctx, error)))?;
    let answer: Value = serde_json::from_str(&text).map_err(|error| broken(error.to_string()))?;
    if answer.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(answer.get("value").cloned().unwrap_or(Value::Null));
    }
    if let Some(detail) = answer.get("detail").and_then(Value::as_str).filter(|detail| !detail.is_empty()) {
        eprintln!("[archive] {name}: {detail}");
    }
    Err(Failure {
        status: answer.get("status").and_then(Value::as_u64).unwrap_or(500) as u16,
        message: answer.get("message").and_then(Value::as_str).unwrap_or("Errore dell'archivio.").to_string(),
    })
}

fn run(path: &Path, recover: bool, queue: mpsc::Receiver<Job>, ready: mpsc::Sender<Result<(), String>>) {
    let opened = (|| -> Result<(Rc<Connection>, Runtime, Context), String> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        db.set_prepared_statement_cache_capacity(256);
        let runtime = Runtime::new().map_err(|e| e.to_string())?;
        runtime.set_max_stack_size(4 * 1024 * 1024);
        let context = Context::full(&runtime).map_err(|e| e.to_string())?;
        let db = Rc::new(db);
        start(db.clone(), &context, recover)?;
        Ok((db, runtime, context))
    })();
    let (_db, runtime, context) = match opened {
        Ok(parts) => {
            let _ = ready.send(Ok(()));
            parts
        }
        Err(message) => {
            let _ = ready.send(Err(message));
            return;
        }
    };
    for job in queue {
        let answer = context.with(|ctx| call(&ctx, job.name, &job.argument));
        let _ = job.reply.send(answer);
        // What the scripts no longer hold is given back between one request and the next.
        while runtime.is_job_pending() {
            if runtime.execute_pending_job().is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive() -> (Archive, PathBuf) {
        let dir = std::env::temp_dir().join(format!("synthorg-archive-test-{}", uuid::Uuid::new_v4()));
        let archive = Archive::open(&dir.join("archive.sqlite"), true).expect("the archive opens");
        (archive, dir)
    }

    fn block<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }

    #[test]
    fn the_query_string_is_read_as_the_page_wrote_it() {
        let query = parse_query("q=due%20parole&archived=false&from=2026-10-01T09%3A00&x=a+b&empty=");
        assert_eq!(query["q"], "due parole");
        assert_eq!(query["archived"], "false");
        assert_eq!(query["from"], "2026-10-01T09:00");
        assert_eq!(query["x"], "a b");
        assert_eq!(query["empty"], "");
        assert_eq!(parse_query("x=100%")["x"], "100%");
        assert_eq!(parse_query("x=%C3%A8")["x"], "è");
    }

    #[test]
    fn the_rules_of_the_computer_run_on_the_phone() {
        let (archive, dir) = archive();
        block(async {
            // A setting, written and read back.
            let put = archive.request("PUT", "/api/settings/app_locale", None, json!({ "value": "en" })).await.unwrap();
            assert_eq!((put.status, &put.data), (200, &json!({ "key": "app_locale", "value": "en" })));
            let all = archive.request("GET", "/api/settings", None, Value::Null).await.unwrap();
            assert_eq!(all.data["app_locale"], "en");

            // A chat made here, with the id this phone gives it; a message; the title taken from it.
            let chat = archive.request("POST", "/api/conversations", None, json!({})).await.unwrap();
            assert_eq!(chat.status, 200);
            let id = chat.data["id"].as_str().unwrap().to_string();
            assert_eq!(id.len(), 36);
            let saved = archive.request("POST", &format!("/api/conversations/{id}/messages"), None, json!({ "id": "m1", "role": "user", "content": "ciao dal telefono" })).await.unwrap();
            assert_eq!(saved.status, 200);
            let whole = archive.request("GET", &format!("/api/conversations/{id}"), None, Value::Null).await.unwrap();
            assert_eq!(whole.data["conversation"]["title"], "ciao dal telefono");
            assert_eq!(whole.data["messages"][0]["content"], "ciao dal telefono");
            let list = archive.request("GET", "/api/conversations", Some("q=telefono&archived=false"), Value::Null).await.unwrap();
            assert_eq!(list.data.as_array().unwrap().len(), 1);
            assert_eq!(list.data[0]["message_count"], 1);

            // The assistant's pages: the agenda, a habit and its days, a note found by its words.
            let item = archive.request("POST", "/api/agenda", None, json!({ "kind": "reminder", "title": "Dentista", "startAt": "2026-10-02T09:00" })).await.unwrap();
            assert_eq!((item.status, &item.data["start_at"]), (200, &json!("2026-10-02T09:00")));
            let day = archive.request("GET", "/api/agenda", Some("from=2026-10-02T00%3A00&to=2026-10-03T00%3A00"), Value::Null).await.unwrap();
            assert_eq!(day.data.as_array().unwrap().len(), 1);
            let habit = archive.request("POST", "/api/habits", None, json!({ "name": "Camminare", "sign": "positive" })).await.unwrap();
            let marked = archive.request("PUT", "/api/habits/days", None, json!({ "habitId": habit.data["id"], "day": "2026-10-01", "done": true })).await.unwrap();
            assert_eq!(marked.data["done"], 1);
            let note = archive.request("POST", "/api/memories", None, json!({ "content": "Preferisce il tè verde", "scope": "global" })).await.unwrap();
            assert_eq!(note.status, 200);
            // (the notes go with a request when the chat's memory is on, as on the computer)
            let switched = archive.request("PATCH", &format!("/api/conversations/{id}"), None, json!({ "memoryEnabled": true })).await.unwrap();
            assert_eq!(switched.data["memory_enabled"], 1);
            let context = archive.request("POST", &format!("/api/conversations/{id}/context"), None, json!({ "query": "che tè preferisce?" })).await.unwrap();
            assert_eq!(context.status, 200, "{}", context.data);
            assert_eq!(context.data["memories"][0]["content"], "Preferisce il tè verde");
            let assistant = archive.request("GET", "/api/realtime", None, Value::Null).await.unwrap();
            assert_eq!(assistant.data["conversation"]["kind"], "realtime");

            // What the rules refuse is refused here as there, with the same words.
            let bad = archive.request("POST", "/api/agenda", None, json!({ "kind": "x", "title": "y", "startAt": "2026-10-02T09:00" })).await.unwrap();
            assert_eq!((bad.status, &bad.data["error"]), (400, &json!("Tipo non valido: promemoria o attività.")));
            let missing = archive.request("GET", "/api/conversations/none", None, Value::Null).await.unwrap();
            assert_eq!(missing.status, 404);
            assert_eq!(archive.request("POST", "/api/agenda", None, json!([1])).await.unwrap().status, 400);

            // What needs the machine is not the archive's.
            assert!(archive.request("GET", &format!("/api/conversations/{id}/sandbox"), None, Value::Null).await.is_none());
            assert!(archive.request("GET", &format!("/api/conversations/{id}/sandbox/files/cartella/foto.png"), None, Value::Null).await.is_none());
            assert!(archive.request("POST", "/api/projects", None, json!({})).await.is_none());
            assert!(archive.request("GET", "/api/github", None, Value::Null).await.is_none());

            // What this phone wrote waits for the computer: the rows, as they were written.
            assert!(archive.waiting("computer").await > 0);
            let offer = archive.offer("computer").await.unwrap();
            let rows = offer["rows"].as_array().unwrap();
            assert!(rows.iter().any(|row| row["t"] == "messages" && row["d"]["content"] == "ciao dal telefono"));
            assert!(rows.iter().any(|row| row["t"] == "settings" && row["k"][0] == "app_locale"));
        });
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rows_of_the_computer_are_written_and_told_to_the_page() {
        let (archive, dir) = archive();
        block(async {
            let answer = json!({
                "site": "computer-site", "have": 0, "after": 0, "upto": 3, "more": false,
                "rows": [
                    { "t": "settings", "k": ["realtime_name"], "at": 1790000000000i64, "d": { "key": "realtime_name", "value": "Mo", "updated_at": "2026-10-01T08:00:00.000Z" } },
                    { "t": "conversations", "k": ["c1"], "at": 1790000000000i64, "d": { "id": "c1", "title": "Dal computer", "archived": 0, "memory_enabled": 0, "created_at": "2026-10-01T08:00:00.000Z", "updated_at": "2026-10-01T08:00:00.000Z", "kind": "chat" } },
                    { "t": "messages", "k": ["m1"], "at": 1790000000000i64, "d": { "sequence": 28640000000000i64, "id": "m1", "conversation_id": "c1", "role": "assistant", "kind": "final", "status": "complete", "content": "eccomi", "meta_json": "{}", "created_at": "2026-10-01T08:00:00.000Z", "updated_at": "2026-10-01T08:00:00.000Z" } }
                ]
            });
            let took = archive.answered("computer", answer).await.unwrap();
            assert_eq!(took["reset"], false);
            let changes = took["changes"].as_array().unwrap();
            assert!(changes.iter().any(|change| change["path"] == "/api/settings/realtime_name" && change["data"]["value"] == "Mo"));
            assert!(changes.iter().any(|change| change["path"] == "/api/conversations/c1/messages" && change["data"]["content"] == "eccomi"));
            let chat = archive.request("GET", "/api/conversations/c1", None, Value::Null).await.unwrap();
            assert_eq!(chat.data["messages"][0]["sequence"], 28640000000000i64);
            // Nothing of it goes back to where it came from.
            assert_eq!(archive.waiting("computer").await, 0);
            // A message written here after takes its place after the computer's.
            archive.request("POST", "/api/conversations/c1/messages", None, json!({ "id": "m2", "role": "user", "content": "grazie" })).await.unwrap();
            let chat = archive.request("GET", "/api/conversations/c1", None, Value::Null).await.unwrap();
            assert_eq!(chat.data["messages"][1]["id"], "m2");
            assert!(chat.data["messages"][1]["sequence"].as_i64().unwrap() > 28640000000000i64);
        });
        let _ = std::fs::remove_dir_all(dir);
    }
}
