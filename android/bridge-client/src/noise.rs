//! The Noise handshake, byte for byte as `computer/server/bridge-noise.js`:
//!
//! ```text
//! <- s
//! -> e, es, e1
//! <- e, ee, ekem1
//! -> s, se            (pairing: s, se, psk)
//! ```
//!
//! `Noise_XKhfs_25519+MLKEM768_ChaChaPoly_SHA256` for a session,
//! `Noise_XKhfspsk3_25519+MLKEM768_ChaChaPoly_SHA256` for a pairing. The
//! phone is the initiator; the responder side exists here so the handshake
//! can be tested without the desktop.

use crate::error::{Error, Result};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hmac::{Hmac, Mac};
use ml_kem::{DecapsulationKey, Decapsulate, EncapsulationKey, KeyExport, MlKem768};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

pub const NAME_SESSION: &str = "Noise_XKhfs_25519+MLKEM768_ChaChaPoly_SHA256";
pub const NAME_PAIRING: &str = "Noise_XKhfspsk3_25519+MLKEM768_ChaChaPoly_SHA256";
pub const PROLOGUE: &[u8] = b"synthorg-bridge/1";
pub const KEY: usize = 32;
pub const TAG: usize = 16;
pub const KEM_PUBLIC: usize = 1184;
pub const KEM_CIPHERTEXT: usize = 1088;

/// The kind of link, sent as the first block of a stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Session = 1,
    Pairing = 2,
}

impl Kind {
    pub fn byte(self) -> u8 {
        self as u8
    }
    fn name(self) -> &'static str {
        match self {
            Kind::Session => NAME_SESSION,
            Kind::Pairing => NAME_PAIRING,
        }
    }
}

fn fail<T>(message: &str) -> Result<T> {
    Err(Error::Channel(message.into()))
}

/// Cryptographic randomness from the OS.
pub(crate) fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the OS random source is available");
    out
}

/// An X25519 key pair. The private key is kept raw (32 bytes, clamped at use),
/// as Node's JWK `d` is, so that the two sides store keys the same way.
#[derive(Clone)]
pub struct Keypair {
    pub private: [u8; 32],
    pub public: [u8; 32],
}

impl Keypair {
    pub fn generate() -> Self {
        Self::from_private(random())
    }
    pub fn from_private(private: [u8; 32]) -> Self {
        let public = x25519_dalek::x25519(private, x25519_dalek::X25519_BASEPOINT_BYTES);
        Keypair { private, public }
    }
}

impl Drop for Keypair {
    fn drop(&mut self) {
        self.private.zeroize();
    }
}

fn dh(private: &[u8; 32], public: &[u8]) -> Result<[u8; 32]> {
    let public: [u8; 32] = match public.try_into() {
        Ok(key) => key,
        Err(_) => return fail("bad public key"),
    };
    let shared = x25519_dalek::x25519(*private, public);
    // A point of small order gives zeros: a key nobody holds.
    if shared.iter().all(|&b| b == 0) {
        return fail("bad public key");
    }
    Ok(shared)
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    for p in parts {
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// Noise HKDF with `outputs` outputs of 32 bytes.
fn hkdf(chaining_key: &[u8; 32], material: &[u8], outputs: usize) -> Vec<[u8; 32]> {
    let mut temp = hmac(chaining_key, &[material]);
    let mut out: Vec<[u8; 32]> = Vec::with_capacity(outputs);
    for i in 1..=outputs as u8 {
        let last: &[u8] = out.last().map(|l| &l[..]).unwrap_or(&[]);
        let next = hmac(&temp, &[last, &[i]]);
        out.push(next);
    }
    temp.zeroize();
    out
}

/// ChaCha20-Poly1305 with the Noise nonce: 4 zero bytes, then a 64-bit little-endian counter.
pub struct CipherState {
    key: Option<[u8; 32]>,
    nonce: u64,
}

impl CipherState {
    fn new(key: Option<[u8; 32]>) -> Self {
        CipherState { key, nonce: 0 }
    }

    fn iv(&self) -> Nonce {
        let mut iv = [0u8; 12];
        iv[4..].copy_from_slice(&self.nonce.to_le_bytes());
        Nonce::from(iv)
    }

    pub fn encrypt(&mut self, ad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
        let Some(key) = &self.key else { return Ok(plaintext.to_vec()) };
        let cipher = ChaCha20Poly1305::new(&Key::from(*key));
        let out = cipher
            .encrypt(&self.iv(), Payload { msg: plaintext, aad: ad })
            .map_err(|_| Error::Channel("encryption failed".into()))?;
        self.nonce += 1;
        Ok(out)
    }

    pub fn decrypt(&mut self, ad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        let Some(key) = &self.key else { return Ok(ciphertext.to_vec()) };
        if ciphertext.len() < TAG {
            return fail("message too short");
        }
        let cipher = ChaCha20Poly1305::new(&Key::from(*key));
        let out = cipher
            .decrypt(&self.iv(), Payload { msg: ciphertext, aad: ad })
            .map_err(|_| Error::Channel("message not authentic".into()))?;
        self.nonce += 1;
        Ok(out)
    }
}

impl Drop for CipherState {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

struct Symmetric {
    h: [u8; 32],
    ck: [u8; 32],
    cipher: CipherState,
}

impl Symmetric {
    fn new(name: &str) -> Self {
        let bytes = name.as_bytes();
        let h = if bytes.len() <= 32 {
            let mut h = [0u8; 32];
            h[..bytes.len()].copy_from_slice(bytes);
            h
        } else {
            sha256(&[bytes])
        };
        Symmetric { h, ck: h, cipher: CipherState::new(None) }
    }
    fn mix_hash(&mut self, data: &[u8]) {
        self.h = sha256(&[&self.h, data]);
    }
    fn mix_key(&mut self, material: &[u8]) {
        let out = hkdf(&self.ck, material, 2);
        self.ck = out[0];
        self.cipher = CipherState::new(Some(out[1]));
    }
    fn mix_key_and_hash(&mut self, material: &[u8]) {
        let out = hkdf(&self.ck, material, 3);
        self.ck = out[0];
        self.mix_hash(&out[1]);
        self.cipher = CipherState::new(Some(out[2]));
    }
    fn encrypt_and_hash(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let out = self.cipher.encrypt(&self.h, plaintext)?;
        self.mix_hash(&out);
        Ok(out)
    }
    fn decrypt_and_hash(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        let out = self.cipher.decrypt(&self.h, ciphertext)?;
        self.mix_hash(ciphertext);
        Ok(out)
    }
    fn split(&self) -> (CipherState, CipherState) {
        let out = hkdf(&self.ck, &[], 2);
        (CipherState::new(Some(out[0])), CipherState::new(Some(out[1])))
    }
}

impl Drop for Symmetric {
    fn drop(&mut self) {
        self.ck.zeroize();
    }
}

/// One side of a handshake.
pub struct Handshake {
    initiator: bool,
    psk: Option<[u8; 32]>,
    s: Keypair,
    rs: Option<[u8; 32]>,
    e: Option<Keypair>,
    re: Option<[u8; 32]>,
    // Initiator: the ML-KEM key pair of e1. Responder: the peer's e1.
    kem: Option<Box<DecapsulationKey<MlKem768>>>,
    re1: Option<Vec<u8>>,
    state: Symmetric,
    step: u8,
}

impl Handshake {
    /// The phone's side: `remote_static` is the desktop key from the pairing code.
    pub fn initiator(kind: Kind, s: Keypair, remote_static: [u8; 32], psk: Option<[u8; 32]>) -> Result<Self> {
        Self::new(true, kind, s, Some(remote_static), psk)
    }

    /// The desktop's side, for tests.
    pub fn responder(kind: Kind, s: Keypair, psk: Option<[u8; 32]>) -> Result<Self> {
        Self::new(false, kind, s, None, psk)
    }

    fn new(initiator: bool, kind: Kind, s: Keypair, rs: Option<[u8; 32]>, psk: Option<[u8; 32]>) -> Result<Self> {
        if kind == Kind::Pairing && psk.is_none() {
            return fail("pairing needs its secret");
        }
        let psk = if kind == Kind::Pairing { psk } else { None };
        let mut state = Symmetric::new(kind.name());
        state.mix_hash(&[PROLOGUE, &[kind.byte()]].concat());
        // The pre-message `<- s`: the responder's static key.
        let pre = if initiator { rs.expect("initiator knows the responder key") } else { s.public };
        state.mix_hash(&pre);
        Ok(Handshake { initiator, psk, s, rs, e: None, re: None, kem: None, re1: None, state, step: 0 })
    }

    fn ephemeral(&mut self) -> [u8; 32] {
        let e = Keypair::generate();
        let public = e.public;
        self.state.mix_hash(&public);
        // With a pre-shared key every `e` is also mixed into the key (Noise spec, section 9.2).
        if self.psk.is_some() {
            self.state.mix_key(&public);
        }
        self.e = Some(e);
        public
    }

    fn remote_ephemeral(&mut self, key: &[u8]) {
        let mut re = [0u8; 32];
        re.copy_from_slice(key);
        self.state.mix_hash(&re);
        if self.psk.is_some() {
            self.state.mix_key(&re);
        }
        self.re = Some(re);
    }

    fn e_private(&self) -> &[u8; 32] {
        &self.e.as_ref().expect("ephemeral made").private
    }

    /// The next message this side sends, carrying `payload`.
    pub fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        let step = self.step;
        self.step += 1;
        let mut out = Vec::new();
        match (self.initiator, step) {
            (true, 0) => {
                out.extend_from_slice(&self.ephemeral());
                let shared = dh(self.e_private(), &self.rs.unwrap())?;
                self.state.mix_key(&shared);
                let kem = DecapsulationKey::<MlKem768>::from_seed(random::<64>().into());
                let e1 = kem.encapsulation_key().to_bytes();
                out.extend(self.state.encrypt_and_hash(&e1)?);
                self.kem = Some(Box::new(kem));
            }
            (false, 1) => {
                out.extend_from_slice(&self.ephemeral());
                let shared = dh(self.e_private(), &self.re.unwrap())?;
                self.state.mix_key(&shared);
                let (ciphertext, shared) = encapsulate(self.re1.as_deref().unwrap_or(&[]))?;
                out.extend(self.state.encrypt_and_hash(&ciphertext)?);
                self.state.mix_key(&shared);
            }
            (true, 2) => {
                let public = self.s.public;
                out.extend(self.state.encrypt_and_hash(&public)?);
                let shared = dh(&self.s.private, &self.re.unwrap())?;
                self.state.mix_key(&shared);
                if let Some(psk) = self.psk {
                    self.state.mix_key_and_hash(&psk);
                }
            }
            _ => return fail("handshake step out of order"),
        }
        out.extend(self.state.encrypt_and_hash(payload)?);
        Ok(out)
    }

    /// The message the other side sent; returns its payload.
    pub fn read(&mut self, message: &[u8]) -> Result<Vec<u8>> {
        let step = self.step;
        self.step += 1;
        let mut at = 0usize;
        let mut take = |length: usize| -> Result<&[u8]> {
            if at + length > message.len() {
                return fail("handshake message too short");
            }
            let piece = &message[at..at + length];
            at += length;
            Ok(piece)
        };
        match (self.initiator, step) {
            (false, 0) => {
                let re = take(KEY)?;
                self.remote_ephemeral(re);
                let shared = dh(&self.s.private, &self.re.unwrap())?;
                self.state.mix_key(&shared);
                let e1 = take(KEM_PUBLIC + TAG)?;
                self.re1 = Some(self.state.decrypt_and_hash(e1)?);
            }
            (true, 1) => {
                let re = take(KEY)?;
                self.remote_ephemeral(re);
                let shared = dh(self.e_private(), &self.re.unwrap())?;
                self.state.mix_key(&shared);
                let ciphertext = self.state.decrypt_and_hash(take(KEM_CIPHERTEXT + TAG)?)?;
                if ciphertext.len() != KEM_CIPHERTEXT {
                    return fail("bad ML-KEM ciphertext");
                }
                let kem = self.kem.take().expect("e1 was sent");
                let shared = kem.decapsulate_slice(&ciphertext).map_err(|_| Error::Channel("bad ML-KEM ciphertext".into()))?;
                self.state.mix_key(&shared);
            }
            (false, 2) => {
                let rs = self.state.decrypt_and_hash(take(KEY + TAG)?)?;
                let rs: [u8; 32] = rs.try_into().map_err(|_| Error::Channel("bad static key".into()))?;
                self.rs = Some(rs);
                let shared = dh(self.e_private(), &rs)?;
                self.state.mix_key(&shared);
                if let Some(psk) = self.psk {
                    self.state.mix_key_and_hash(&psk);
                }
            }
            _ => return fail("handshake step out of order"),
        }
        let rest = &message[at..];
        self.state.decrypt_and_hash(rest)
    }

    pub fn is_done(&self) -> bool {
        self.step == 3
    }

    /// The two ciphers of the channel: (send, receive) for this side.
    pub fn split(self) -> Result<(CipherState, CipherState)> {
        if !self.is_done() {
            return fail("handshake not finished");
        }
        let (first, second) = self.state.split();
        Ok(if self.initiator { (first, second) } else { (second, first) })
    }

    /// The handshake hash: the same at both ends of one handshake, and only there.
    pub fn hash(&self) -> [u8; 32] {
        self.state.h
    }

    /// The peer's static key (known from the start on the initiator, after message 3 on the responder).
    pub fn remote_static(&self) -> Option<[u8; 32]> {
        self.rs
    }
}

fn encapsulate(public: &[u8]) -> Result<(Vec<u8>, [u8; 32])> {
    if public.len() != KEM_PUBLIC {
        return fail("bad ML-KEM key");
    }
    let key = ml_kem::Key::<EncapsulationKey<MlKem768>>::try_from(public).map_err(|_| Error::Channel("bad ML-KEM key".into()))?;
    let ek = EncapsulationKey::<MlKem768>::new(&key).map_err(|_| Error::Channel("bad ML-KEM key".into()))?;
    let (ciphertext, shared) = ek.encapsulate_deterministic(&random::<32>().into());
    Ok((ciphertext.to_vec(), shared.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(kind: Kind, psk_i: Option<[u8; 32]>, psk_r: Option<[u8; 32]>) -> Result<(Handshake, Handshake, Vec<u8>)> {
        let desktop = Keypair::generate();
        let phone = Keypair::generate();
        let mut i = Handshake::initiator(kind, phone, desktop.public, psk_i)?;
        let mut r = Handshake::responder(kind, desktop, psk_r)?;
        let m1 = i.write(&[])?;
        // e, encrypted e1, encrypted empty payload: the same size for both kinds.
        assert_eq!(m1.len(), KEY + KEM_PUBLIC + TAG + TAG);
        r.read(&m1)?;
        let m2 = r.write(&[])?;
        assert_eq!(m2.len(), KEY + KEM_CIPHERTEXT + TAG + TAG);
        i.read(&m2)?;
        let m3 = i.write(br#"{"name":"t","platform":"android"}"#)?;
        let payload = r.read(&m3)?;
        Ok((i, r, payload))
    }

    #[test]
    fn session_handshake_agrees() {
        let (i, r, payload) = run(Kind::Session, None, None).unwrap();
        assert_eq!(payload, br#"{"name":"t","platform":"android"}"#);
        assert_eq!(i.hash(), r.hash());
        assert_eq!(r.remote_static(), Some(i.s.public));
        let (mut is, mut ir) = i.split().unwrap();
        let (mut rs, mut rr) = r.split().unwrap();
        let c = is.encrypt(&[], b"hello").unwrap();
        assert_eq!(rr.decrypt(&[], &c).unwrap(), b"hello");
        let c = rs.encrypt(&[], b"back").unwrap();
        assert_eq!(ir.decrypt(&[], &c).unwrap(), b"back");
    }

    #[test]
    fn pairing_needs_the_same_secret() {
        let (i, r, _) = run(Kind::Pairing, Some([7; 32]), Some([7; 32])).unwrap();
        assert_eq!(i.hash(), r.hash());
        assert!(matches!(run(Kind::Pairing, Some([7; 32]), Some([8; 32])), Err(Error::Channel(_))));
        assert!(Handshake::initiator(Kind::Pairing, Keypair::generate(), [9; 32], None).is_err());
    }

    #[test]
    fn a_forged_record_is_refused() {
        let (i, r, _) = run(Kind::Session, None, None).unwrap();
        let (mut send, _) = i.split().unwrap();
        let (_, mut receive) = r.split().unwrap();
        let mut c = send.encrypt(&[], b"hello").unwrap();
        c[0] ^= 1;
        assert!(matches!(receive.decrypt(&[], &c), Err(Error::Channel(_))));
    }

    #[test]
    fn hkdf_matches_rfc5869_with_empty_info() {
        // RFC 5869 test case 3 (SHA-256, empty salt and info): Noise's HKDF is
        // HKDF-Extract then Expand with empty info, so the first output is OKM[0..32].
        let ikm = [0x0bu8; 22];
        let salt = [0u8; 32]; // an empty salt is 32 zero bytes for HMAC-SHA256
        let out = hkdf(&salt, &ikm, 2);
        let okm = data_encoding::HEXLOWER
            .decode(b"8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
            .unwrap();
        assert_eq!(&out[0][..], &okm[..32]);
        assert_eq!(&out[1][..10], &okm[32..]);
    }
}
