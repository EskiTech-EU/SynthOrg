//! The Rust phone against the desktop's own Node channel code
//! (tests/node-peer.js requires computer/server/bridge-noise.js), over plain
//! TCP instead of I2P. Needs `node` (v24, for ML-KEM in node:crypto) on PATH.

use bridge_client::{ConnState, Error, NetSession, Network, Phone, PhoneConfig, Result, Via};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::net::TcpStream;

/* The desktop: a Node process ------------------------------------------ */

struct Peer {
    child: Child,
    port: u16,
    code: String,
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn peer(args: &[&str]) -> Peer {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/node-peer.js");
    let mut child = Command::new("node")
        .arg(script)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("node on PATH");
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let info: Value = serde_json::from_str(&line).expect("node-peer prints its port");
    Peer { port: info["port"].as_u64().unwrap() as u16, code: info["code"].as_str().unwrap().to_string(), child }
}

/* The network: TCP to the peer, with a count of sessions made ------------ */

#[derive(Clone)]
struct TcpNet {
    port: u16,
    sessions: Arc<AtomicUsize>,
    /// Connects that fail with Unreachable before one gets through, per session.
    unreachable: usize,
}

struct TcpSession {
    port: u16,
    failures: AtomicUsize,
    unreachable: usize,
}

impl Network for TcpNet {
    type Session = TcpSession;
    async fn session(&self, _reader_key: [u8; 32]) -> Result<TcpSession> {
        self.sessions.fetch_add(1, Ordering::SeqCst);
        Ok(TcpSession { port: self.port, failures: AtomicUsize::new(0), unreachable: self.unreachable })
    }
}

impl NetSession for TcpSession {
    type Stream = TcpStream;
    async fn connect(&self, address: &str) -> Result<TcpStream> {
        assert!(address.ends_with(".b32.i2p"));
        if self.failures.fetch_add(1, Ordering::SeqCst) < self.unreachable {
            return Err(Error::Unreachable("CANT_REACH_PEER".into()));
        }
        Ok(TcpStream::connect(("127.0.0.1", self.port)).await?)
    }
    fn is_closed(&self) -> bool {
        false
    }
}

fn net(peer: &Peer) -> TcpNet {
    TcpNet { port: peer.port, sessions: Arc::new(AtomicUsize::new(0)), unreachable: 0 }
}

fn config() -> PhoneConfig {
    PhoneConfig {
        retry: Duration::from_millis(20),
        handshake_timeout: Duration::from_secs(5),
        call_timeout: Duration::from_secs(10),
        reconnect: vec![Duration::from_millis(100)],
        // The network alone: the local way has tests of its own.
        lan: false,
        ..PhoneConfig::default()
    }
}

async fn wait_via(phone: &Phone<TcpNet>, wanted: Via) {
    let mut via = phone.via();
    tokio::time::timeout(Duration::from_secs(15), via.wait_for(|v| *v == wanted)).await.expect("way reached").unwrap();
}

async fn wait_state(phone: &Phone<TcpNet>, wanted: ConnState) {
    let mut state = phone.state();
    tokio::time::timeout(Duration::from_secs(10), state.wait_for(|s| *s == wanted)).await.expect("state reached").unwrap();
}

/* Tests ----------------------------------------------------------------- */

#[tokio::test]
async fn pairs_calls_and_reconnects() {
    let peer = peer(&[]);
    let network = net(&peer);
    let phone = Phone::new(network.clone(), None, config());
    let mut events = phone.events();

    let identity = phone.pair(&peer.code, "Test phone").await.unwrap();
    assert!(identity.device_id.is_some());
    assert_eq!(*phone.state().borrow(), ConnState::Online);
    let welcome = phone.welcome().unwrap();
    assert!(welcome.paired);
    assert_eq!(welcome.desktop.name, "node-peer");
    assert_eq!(welcome.device.name, "Test phone");
    assert_eq!(Some(welcome.device.id.clone()), identity.device_id);
    let first = events.recv().await.unwrap();
    assert_eq!(first.name, "welcome");
    assert_eq!(first.data["keepaliveMs"], 45000);

    // What the phone said of itself in the third handshake message.
    let (hello, _) = phone.call("hello", json!({}), None).await.unwrap();
    assert_eq!(hello, json!({ "platform": "android", "name": "Test phone" }));

    // A body of many 16 KiB pieces, both ways.
    let body: Vec<u8> = (0..1_000_000u32).map(|i| (i * 7) as u8).collect();
    let (result, back) = phone.call("echo", json!({ "a": [1, "ü"] }), Some(body.clone())).await.unwrap();
    assert_eq!(result["params"], json!({ "a": [1, "ü"] }));
    assert_eq!(result["bodyLength"], 1_000_000);
    assert_eq!(back, body);

    // Several calls at once, matched by id.
    let calls = (0..20).map(|n| {
        let phone = phone.clone();
        async move { phone.call("echo", json!({ "n": n }), Some(vec![n as u8; n * 1000])).await.unwrap() }
    });
    for (n, (result, back)) in futures_join(calls).await.into_iter().enumerate() {
        assert_eq!(result["params"]["n"], n);
        assert_eq!(back.len(), n * 1000);
    }

    match phone.call("fail", Value::Null, None).await {
        Err(Error::Remote { code, message }) => {
            assert_eq!(code, "test_fail");
            assert_eq!(message, "Failed on purpose.");
        }
        other => panic!("expected a refusal, got {other:?}"),
    }

    phone.call("emit", json!({ "n": 7 }), None).await.unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event.name, "test.event");
    assert_eq!(event.data, json!({ "n": 7 }));
    assert_eq!(event.body, [1, 2, 3]);

    // Too big to send: refused here, the channel stays up.
    let too_big = phone.call("echo", json!({}), Some(vec![0; 24 * 1024 * 1024])).await;
    assert!(matches!(too_big, Err(Error::Channel(_))));
    phone.call("ping", json!({}), None).await.unwrap();

    // The desktop drops the stream: a new network session, then online again.
    assert_eq!(network.sessions.load(Ordering::SeqCst), 1);
    phone.call("drop", json!({}), None).await.unwrap();
    wait_state(&phone, ConnState::Offline).await;
    wait_state(&phone, ConnState::Online).await;
    assert_eq!(network.sessions.load(Ordering::SeqCst), 2);
    assert!(!phone.welcome().unwrap().paired);
    let (result, _) = phone.call("echo", json!({ "again": true }), None).await.unwrap();
    assert_eq!(result["params"]["again"], true);

    // A second phone app start: the kept identity opens a session.
    phone.close().await;
    assert_eq!(*phone.state().borrow(), ConnState::Offline);
    assert!(matches!(phone.call("ping", json!({}), None).await, Err(Error::NotConnected)));
    let saved = serde_json::to_string(&identity).unwrap();
    assert!(saved.contains("\"staticKey\"") && saved.contains("\"readerKey\"") && saved.contains("\"publicKey\""));
    let again = Phone::new(net(&peer), Some(serde_json::from_str(&saved).unwrap()), config());
    let welcome = again.connect().await.unwrap();
    assert!(!welcome.paired);
    assert_eq!(Some(welcome.device.id), identity.device_id);
    let (result, _) = again.call("ping", json!({}), None).await.unwrap();
    assert_eq!(result["page"], true);

    // The code was used: pairing again with it fails.
    let late = Phone::new(net(&peer), None, config());
    assert!(late.pair(&peer.code, "Late").await.is_err());
    assert_eq!(*late.state().borrow(), ConnState::Offline);
}

#[tokio::test]
async fn pings_every_keepalive() {
    let peer = peer(&["--keepalive", "200"]);
    let phone = Phone::new(net(&peer), None, config());
    phone.pair(&peer.code, "Pinger").await.unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let (result, _) = phone.call("pings", json!({}), None).await.unwrap();
    let count = result["count"].as_u64().unwrap();
    assert!((4..=6).contains(&count), "pings: {count}");
    assert_eq!(*phone.state().borrow(), ConnState::Online);
}

#[tokio::test]
async fn wrong_secret_or_unknown_phone_is_refused() {
    let peer = peer(&[]);
    // Same code, another secret.
    let mut parts: Vec<String> = peer.code.split(':').map(String::from).collect();
    parts[4] = data_encoding::BASE32_NOPAD.encode(&[5u8; 32]);
    let phone = Phone::new(net(&peer), None, config());
    let result = phone.pair(&parts.join(":"), "Guess").await;
    assert!(matches!(result, Err(Error::Closed)), "{result:?}");
    assert!(phone.identity().is_none());
    assert!(phone.last_error().is_some());

    // A phone the desktop never paired with.
    let stranger = bridge_client::Identity {
        static_key: "11".repeat(32),
        reader_key: "22".repeat(32),
        desktop: bridge_client::PairedDesktop {
            address: format!("{}.b32.i2p", "a".repeat(56)),
            public_key: {
                let code = bridge_client::code::parse(&peer.code).unwrap();
                data_encoding::HEXLOWER.encode(&code.public_key)
            },
        },
        device_id: None,
    };
    let phone = Phone::new(net(&peer), Some(stranger), config());
    assert!(matches!(phone.connect().await, Err(Error::Closed)));
    assert!(matches!(Phone::new(net(&peer), None, config()).connect().await, Err(Error::NotPaired)));
}

#[tokio::test]
async fn retries_while_the_address_is_looked_up() {
    let peer = peer(&[]);
    let mut network = net(&peer);
    network.unreachable = 5;
    let phone = Phone::new(network, None, config());
    phone.pair(&peer.code, "Patient").await.unwrap();

    // A pairing goes on for as long as its code lasts: a router just started
    // on the computer may be slow to publish the address.
    let peer = self::peer(&[]);
    let mut network = net(&peer);
    network.unreachable = 20;
    let phone = Phone::new(network, None, config());
    let identity = phone.pair(&peer.code, "Patient too").await.unwrap();

    // A session gives up after `tries`, and the app tries again later.
    let mut network = net(&peer);
    network.unreachable = 6;
    let phone = Phone::new(network, Some(identity), config());
    assert!(matches!(phone.connect().await, Err(Error::Unreachable(_))));
}

/// Joins futures without pulling in the futures crate.
async fn futures_join<F: std::future::Future + Send + 'static>(futures: impl Iterator<Item = F>) -> Vec<F::Output>
where
    F::Output: Send + 'static,
{
    let handles: Vec<_> = futures.map(tokio::spawn).collect();
    let mut out = Vec::new();
    for handle in handles {
        out.push(handle.await.unwrap());
    }
    out
}
