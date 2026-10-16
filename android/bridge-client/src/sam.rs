//! A client of the I2P router's SAM interface (v3.1 to 3.3), for the phone:
//! a fresh destination, a streaming session on it that can read the
//! desktop's encrypted leaseset, and streams to the desktop.
//!
//! Mirrors `computer/server/bridge-sam.js`. A session lives as long as its
//! control socket stays open; every stream takes a socket of its own which,
//! after the router's answer, carries the stream's bytes and nothing else.

use crate::client::{NetSession, Network};
use crate::error::{Error, Result};
use data_encoding::BASE64;
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::task::JoinHandle;

pub const SIGNATURE_ED25519: u16 = 7;
pub const SIGNATURE_BLINDED: u8 = 11;
/// ML-KEM-768 + X25519 where the other router knows it, X25519 alone otherwise.
pub const ENCRYPTION: [&str; 2] = ["6,4", "4"];

/* ------------------------------------------------------------------ */
/* Encodings                                                            */
/* ------------------------------------------------------------------ */

/// I2P writes base64 with `-` and `~` in place of `+` and `/` (padding kept).
pub fn to_i2p64(bytes: &[u8]) -> String {
    BASE64.encode(bytes).replace('+', "-").replace('/', "~")
}

pub fn from_i2p64(text: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(text.trim().replace('-', "+").replace('~', "/").as_bytes())
        .map_err(|_| Error::Router("bad I2P base64".into()))
}

/// RFC 4648 base32, lower case, no padding: the alphabet of `.b32.i2p` addresses.
pub fn base32(bytes: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(bytes).to_ascii_lowercase()
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// The address of a destination with an encrypted leaseset (blinded, sig type
/// 7 to 11), as `hiddenAddress` in bridge-sam.js computes it. The phone does
/// not need it to connect (the address comes from the code); it is here to
/// check a destination against a code.
pub fn hidden_address(destination: &str) -> Result<String> {
    let bytes = from_i2p64(destination)?;
    if bytes.len() < 389 || u16::from_be_bytes([bytes[387], bytes[388]]) != SIGNATURE_ED25519 {
        return Err(Error::Router("destination not fit for a hidden address".into()));
    }
    let key = &bytes[352..384];
    let mut data = vec![0x04, SIGNATURE_ED25519 as u8, SIGNATURE_BLINDED];
    data.extend_from_slice(key);
    let sum = crc32(key);
    data[0] ^= sum as u8;
    data[1] ^= (sum >> 8) as u8;
    data[2] ^= (sum >> 16) as u8;
    Ok(base32(&data) + ".b32.i2p")
}

/* ------------------------------------------------------------------ */
/* Replies                                                              */
/* ------------------------------------------------------------------ */

/// A reply of the router: its bare words and its KEY=value pairs.
#[derive(Debug, Default)]
pub struct Reply {
    pub words: Vec<String>,
    pub values: HashMap<String, String>,
    pub line: String,
}

impl Reply {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }
    /// What went wrong, for a message: MESSAGE, else RESULT, else the whole line.
    fn reason(&self) -> String {
        self.get("MESSAGE").or(self.get("RESULT")).unwrap_or(&self.line).to_string()
    }
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.'
}

/// Same tokens as the regex of `parseReply`:
/// `([A-Za-z0-9_.]+)=("(?:[^"\\]|\\.)*"|\S*)|(\S+)`.
pub fn parse_reply(line: &str) -> Reply {
    let mut reply = Reply { line: line.to_string(), ..Default::default() };
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        let mut k = i;
        while k < chars.len() && is_key_char(chars[k]) {
            k += 1;
        }
        if k > start && k < chars.len() && chars[k] == '=' {
            let key: String = chars[start..k].iter().collect();
            let mut j = k + 1;
            if j < chars.len() && chars[j] == '"' {
                // A quoted value, with backslash escapes; unterminated falls back to \S*.
                let mut value = String::new();
                let mut q = j + 1;
                let mut closed = false;
                while q < chars.len() {
                    match chars[q] {
                        '\\' if q + 1 < chars.len() => {
                            value.push(chars[q + 1]);
                            q += 2;
                        }
                        '"' => {
                            closed = true;
                            q += 1;
                            break;
                        }
                        c => {
                            value.push(c);
                            q += 1;
                        }
                    }
                }
                if closed {
                    reply.values.insert(key, value);
                    i = q;
                    continue;
                }
            }
            let begin = j;
            while j < chars.len() && !chars[j].is_whitespace() {
                j += 1;
            }
            reply.values.insert(key, chars[begin..j].iter().collect());
            i = j;
        } else {
            let mut j = i;
            while j < chars.len() && !chars[j].is_whitespace() {
                j += 1;
            }
            reply.words.push(chars[i..j].iter().collect());
            i = j;
        }
    }
    reply
}

/* ------------------------------------------------------------------ */
/* Connections to the router                                            */
/* ------------------------------------------------------------------ */

/// Anything a SAM socket can be: TCP, a pipe to a process, a test double.
pub trait AsyncIo: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> AsyncIo for T {}
pub type BoxIo = Box<dyn AsyncIo>;

/// Opens a connection to the router's SAM interface.
pub trait Dialer: Send + Sync + 'static {
    fn dial(&self) -> Pin<Box<dyn Future<Output = io::Result<BoxIo>> + Send + '_>>;
}

/// SAM over TCP, the usual way (i2pd and the Java router listen on 127.0.0.1:7656).
pub struct TcpDialer {
    pub host: String,
    pub port: u16,
}

impl Dialer for TcpDialer {
    fn dial(&self) -> Pin<Box<dyn Future<Output = io::Result<BoxIo>> + Send + '_>> {
        Box::pin(async move {
            let socket = tokio::net::TcpStream::connect((self.host.as_str(), self.port)).await?;
            socket.set_nodelay(true)?;
            Ok(Box::new(socket) as BoxIo)
        })
    }
}

/// A SAM socket read a line at a time until it is handed over as a stream.
struct Lines {
    io: BoxIo,
    buffer: Vec<u8>,
}

impl Lines {
    async fn send(&mut self, text: &str) -> Result<()> {
        let mut line = text.as_bytes().to_vec();
        line.push(b'\n');
        self.io.write_all(&line).await.map_err(router_io)?;
        self.io.flush().await.map_err(router_io)
    }

    /// The next line that is not a PING. The router asks whether we are still
    /// there, on any socket, at any time: it is answered here.
    async fn line(&mut self) -> Result<String> {
        loop {
            if let Some(at) = self.buffer.iter().position(|&b| b == b'\n') {
                let raw: Vec<u8> = self.buffer.drain(..=at).collect();
                let mut line = String::from_utf8_lossy(&raw[..raw.len() - 1]).into_owned();
                if line.ends_with('\r') {
                    line.pop();
                }
                if is_ping(&line) {
                    let pong = format!("PONG{}", &line[4..]);
                    self.send(&pong).await?;
                    continue;
                }
                return Ok(line);
            }
            let mut chunk = [0u8; 4096];
            let n = self.io.read(&mut chunk).await.map_err(router_io)?;
            if n == 0 {
                return Err(Error::Router("the I2P router closed the connection".into()));
            }
            self.buffer.extend_from_slice(&chunk[..n]);
        }
    }

    async fn line_within(&mut self, limit: Duration) -> Result<String> {
        tokio::time::timeout(limit, self.line())
            .await
            .map_err(|_| Error::Router("the I2P router does not answer".into()))?
    }

    /// From here on the socket is the stream: what was read past the last line goes with it.
    fn release(self) -> SamStream {
        SamStream { head: self.buffer, at: 0, io: self.io }
    }
}

/// `/^PING\b/`: PING alone or followed by a non-word character.
fn is_ping(line: &str) -> bool {
    line.starts_with("PING") && line[4..].chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'))
}

fn router_io(e: io::Error) -> Error {
    Error::Router(e.to_string())
}

/// An I2P stream: the bytes the router read past its answer, then the socket.
pub struct SamStream {
    head: Vec<u8>,
    at: usize,
    io: BoxIo,
}

impl AsyncRead for SamStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.at < self.head.len() {
            let n = (self.head.len() - self.at).min(buf.remaining());
            let at = self.at;
            buf.put_slice(&self.head[at..at + n]);
            self.at += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for SamStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/* ------------------------------------------------------------------ */
/* The client                                                           */
/* ------------------------------------------------------------------ */

#[derive(Clone, Debug)]
pub struct SamConfig {
    pub user: String,
    pub password: String,
    /// For HELLO, DEST GENERATE and the connection itself.
    pub timeout: Duration,
    /// Tunnels built for the session: most of a minute on a router just started.
    pub build_timeout: Duration,
    /// For STREAM CONNECT, which includes looking up the desktop's leaseset.
    pub connect_timeout: Duration,
    pub tunnels: u8,
    pub hops: u8,
}

impl Default for SamConfig {
    fn default() -> Self {
        // As the Node reference phone: 2 tunnels each way, one hop (docs/ponte-telefono.md, «Quanto sono lunghi i tunnel»).
        SamConfig {
            user: String::new(),
            password: String::new(),
            timeout: Duration::from_secs(8),
            build_timeout: Duration::from_secs(180),
            connect_timeout: Duration::from_secs(90),
            tunnels: 2,
            hops: 1,
        }
    }
}

#[derive(Clone)]
pub struct Sam {
    dialer: Arc<dyn Dialer>,
    pub config: SamConfig,
}

fn quote(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

impl Sam {
    /// SAM at `host:port` over TCP.
    pub fn tcp(host: impl Into<String>, port: u16) -> Self {
        Self::with_dialer(Arc::new(TcpDialer { host: host.into(), port }), SamConfig::default())
    }

    pub fn with_dialer(dialer: Arc<dyn Dialer>, config: SamConfig) -> Self {
        Sam { dialer, config }
    }

    async fn open(&self) -> Result<Lines> {
        let io = tokio::time::timeout(self.config.timeout, self.dialer.dial())
            .await
            .map_err(|_| Error::Router("the I2P router does not answer".into()))?
            .map_err(router_io)?;
        let mut lines = Lines { io, buffer: Vec::new() };
        let login = if self.config.user.is_empty() {
            String::new()
        } else {
            format!(" USER=\"{}\" PASSWORD=\"{}\"", quote(&self.config.user), quote(&self.config.password))
        };
        lines.send(&format!("HELLO VERSION MIN=3.1 MAX=3.3{login}")).await?;
        let reply = parse_reply(&lines.line_within(self.config.timeout).await?);
        if reply.get("RESULT") != Some("OK") {
            let auth = reply.get("RESULT") == Some("I2P_ERROR") && reply.get("MESSAGE").unwrap_or("").to_lowercase().contains("auth");
            return Err(Error::Router(if auth {
                "the I2P router asks for user name and password".into()
            } else {
                format!("the I2P router refused the connection: {}", reply.reason())
            }));
        }
        Ok(lines)
    }

    /// Whether a router answers there.
    pub async fn reachable(&self) -> bool {
        self.open().await.is_ok()
    }

    /// A new Ed25519 destination: its private key (I2P base64), which holds the public one.
    pub async fn generate(&self) -> Result<String> {
        let mut lines = self.open().await?;
        lines.send(&format!("DEST GENERATE SIGNATURE_TYPE={SIGNATURE_ED25519}")).await?;
        let reply = parse_reply(&lines.line_within(self.config.timeout).await?);
        reply
            .get("PRIV")
            .map(str::to_string)
            .ok_or_else(|| Error::Router(format!("the I2P router made no destination: {}", reply.line)))
    }

    /// A streaming session on `private_key` that reads hidden leasesets with
    /// `reader_key`. Resolves when the tunnels are built.
    pub async fn session(&self, private_key: &str, reader_key: Option<&[u8; 32]>) -> Result<SamSession> {
        let id = format!("synthorg-{}", data_encoding::HEXLOWER.encode(&crate::noise::random::<6>()));
        let c = &self.config;
        let mut last_error = String::new();
        for encryption in ENCRYPTION {
            let mut lines = self.open().await?;
            let mut options = vec![
                format!("inbound.length={}", c.hops),
                format!("outbound.length={}", c.hops),
                format!("inbound.quantity={}", c.tunnels),
                format!("outbound.quantity={}", c.tunnels),
                format!("i2cp.leaseSetEncType={encryption}"),
            ];
            if let Some(key) = reader_key {
                options.push(format!("i2cp.leaseSetPrivKey={}", to_i2p64(key)));
            }
            lines
                .send(&format!(
                    "SESSION CREATE STYLE=STREAM ID={id} DESTINATION={private_key} SIGNATURE_TYPE={SIGNATURE_ED25519} {}",
                    options.join(" ")
                ))
                .await?;
            let reply = parse_reply(&lines.line_within(c.build_timeout).await?);
            if reply.get("RESULT") == Some("OK") {
                return Ok(SamSession::start(self.clone(), id, lines));
            }
            // A router that does not know type 6 refuses the options: tried again with 4 alone.
            last_error = reply.reason();
        }
        Err(Error::Router(format!("the I2P router did not open the session: {last_error}")))
    }
}

/// A SAM session. Dropping it closes its control socket, and with it the
/// session and its destination.
pub struct SamSession {
    sam: Sam,
    pub id: String,
    closed: Arc<AtomicBool>,
    control: JoinHandle<()>,
}

impl SamSession {
    fn start(sam: Sam, id: String, mut lines: Lines) -> Self {
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        // Whatever the router says on this socket from now on is a ping (answered
        // inside `line`) or the end of the session.
        let control = tokio::spawn(async move {
            while lines.line().await.is_ok() {}
            flag.store(true, Ordering::SeqCst);
        });
        SamSession { sam, id, closed, control }
    }

    /// A stream to a destination or a `.b32.i2p` address.
    pub async fn connect(&self, target: &str) -> Result<SamStream> {
        let mut lines = self.sam.open().await?;
        lines.send(&format!("STREAM CONNECT ID={} DESTINATION={target} SILENT=false", self.id)).await?;
        let reply = parse_reply(&lines.line_within(self.sam.config.connect_timeout).await?);
        if reply.get("RESULT") != Some("OK") {
            return Err(Error::Unreachable(reply.reason()));
        }
        Ok(lines.release())
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl Drop for SamSession {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        self.control.abort();
    }
}

/// The phone's use of SAM: a new destination for every session (see
/// `Phone::online` in scripts/bridge-phone.js for why).
impl Network for Sam {
    type Session = SamSession;

    async fn session(&self, reader_key: [u8; 32]) -> Result<SamSession> {
        let private_key = self.generate().await?;
        Sam::session(self, &private_key, Some(&reader_key)).await
    }
}

impl NetSession for SamSession {
    type Stream = SamStream;

    async fn connect(&self, address: &str) -> Result<SamStream> {
        SamSession::connect(self, address).await
    }

    fn is_closed(&self) -> bool {
        SamSession::is_closed(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i2p64_uses_its_own_alphabet() {
        assert_eq!(to_i2p64(&[0xfb, 0xff, 0xfe]), "-~~-");
        assert_eq!(to_i2p64(&[0xfb, 0xef]), "--8=");
        assert_eq!(to_i2p64(&[0xff, 0xff]), "~~8=");
        assert_eq!(from_i2p64("-~~-").unwrap(), vec![0xfb, 0xff, 0xfe]);
        let key: Vec<u8> = (0..32u8).map(|i| i.wrapping_mul(37)).collect();
        let text = to_i2p64(&key);
        assert_eq!(text.len(), 44);
        assert!(!text.contains('+') && !text.contains('/'));
        assert_eq!(from_i2p64(&text).unwrap(), key);
    }

    #[test]
    fn crc32_is_ieee() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn hidden_address_matches_node() {
        // Destination: bytes i % 251 for 0..387, then a key certificate
        // (type 5, length 4, signing type 7, crypto type 0). Expected value from
        // Node: hiddenAddress() in computer/server/bridge-sam.js.
        let mut dest: Vec<u8> = (0..384u32).map(|i| (i % 251) as u8).collect();
        dest.extend_from_slice(&[5, 0, 4, 0, 7, 0, 0]);
        let address = hidden_address(&to_i2p64(&dest)).unwrap();
        assert_eq!(address, NODE_HIDDEN_ADDRESS);
        assert_eq!(address.len(), 56 + ".b32.i2p".len());
    }
    const NODE_HIDDEN_ADDRESS: &str = "f2bguzlgm5ugs2tlnrww433qofzhg5dvoz3xq6l2pn6h27t7qcayfa4e.b32.i2p";

    #[test]
    fn parses_replies() {
        let r = parse_reply(r#"HELLO REPLY RESULT=OK VERSION=3.3"#);
        assert_eq!(r.words, ["HELLO", "REPLY"]);
        assert_eq!(r.get("RESULT"), Some("OK"));
        assert_eq!(r.get("VERSION"), Some("3.3"));
        let r = parse_reply(r#"STREAM STATUS RESULT=CANT_REACH_PEER MESSAGE="Lease \"set\" not found" X="#);
        assert_eq!(r.get("MESSAGE"), Some(r#"Lease "set" not found"#));
        assert_eq!(r.get("X"), Some(""));
        assert_eq!(r.reason(), r#"Lease "set" not found"#);
        let r = parse_reply("DEST REPLY PUB=abc-~= PRIV=def~-==");
        assert_eq!(r.get("PRIV"), Some("def~-=="));
        assert!(is_ping("PING"));
        assert!(is_ping("PING 12345"));
        assert!(!is_ping("PINGS"));
    }

    /// A fake router on a loopback socket: checks what the client says and the
    /// PING handling, and that bytes after STREAM STATUS go with the stream.
    #[tokio::test]
    async fn talks_sam() {
        use tokio::io::AsyncBufReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = tokio::spawn(async move {
            let mut said = Vec::new();
            // generate, session ("6,4" refused, then "4"), connect
            for step in 0..4 {
                let (socket, _) = listener.accept().await.unwrap();
                let (r, mut w) = socket.into_split();
                let mut r = tokio::io::BufReader::new(r);
                let mut line = String::new();
                r.read_line(&mut line).await.unwrap();
                assert!(line.starts_with("HELLO VERSION MIN=3.1 MAX=3.3"));
                w.write_all(b"HELLO REPLY RESULT=OK VERSION=3.3\n").await.unwrap();
                line.clear();
                r.read_line(&mut line).await.unwrap();
                said.push(line.trim_end().to_string());
                match step {
                    0 => w.write_all(b"DEST REPLY PUB=pub PRIV=priv~key\n").await.unwrap(),
                    1 => w.write_all(b"SESSION STATUS RESULT=I2P_ERROR MESSAGE=\"bad enc\"\n").await.unwrap(),
                    2 => {
                        w.write_all(b"PING 42\nSESSION STATUS RESULT=OK DESTINATION=x\n").await.unwrap();
                        line.clear();
                        r.read_line(&mut line).await.unwrap();
                        assert_eq!(line, "PONG 42\n");
                        // Keep the control socket open for the session's life.
                        tokio::spawn(async move {
                            let _keep = (r, w);
                            tokio::time::sleep(Duration::from_secs(5)).await;
                        });
                    }
                    _ => {
                        w.write_all(b"STREAM STATUS RESULT=OK\nearly").await.unwrap();
                        let mut back = [0u8; 4];
                        r.read_exact(&mut back).await.unwrap();
                        assert_eq!(&back, b"pong");
                    }
                }
            }
            said
        });
        let sam = Sam::tcp("127.0.0.1", port);
        let session = Network::session(&sam, [9; 32]).await.unwrap();
        let mut stream = NetSession::connect(&session, "abc.b32.i2p").await.unwrap();
        let mut early = [0u8; 5];
        stream.read_exact(&mut early).await.unwrap();
        assert_eq!(&early, b"early");
        stream.write_all(b"pong").await.unwrap();
        let said = router.await.unwrap();
        assert_eq!(said[0], "DEST GENERATE SIGNATURE_TYPE=7");
        let options = format!("i2cp.leaseSetPrivKey={}", to_i2p64(&[9; 32]));
        assert!(said[1].contains("i2cp.leaseSetEncType=6,4") && said[1].contains(&options));
        assert!(said[2].starts_with(&format!("SESSION CREATE STYLE=STREAM ID={} DESTINATION=priv~key SIGNATURE_TYPE=7 inbound.length=1 outbound.length=1 inbound.quantity=2 outbound.quantity=2 i2cp.leaseSetEncType=4 ", session.id)));
        assert_eq!(said[3], format!("STREAM CONNECT ID={} DESTINATION=abc.b32.i2p SILENT=false", session.id));
        assert!(!session.is_closed());
    }
}
