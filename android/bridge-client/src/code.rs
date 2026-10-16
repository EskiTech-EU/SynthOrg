//! The pairing code shown by the desktop as a QR code:
//!
//! ```text
//! SYNTHORG-BRIDGE:1:<address>:<desktop key>:<secret>:<reader key>
//! ```
//!
//! Every field after the version is RFC 4648 base32 without padding, in upper
//! case because the QR code is written in alphanumeric mode (see
//! `computer/server/bridge.js`, `openPairing`).

use crate::error::{Error, Result};
use data_encoding::BASE32_NOPAD;

pub const PREFIX: &str = "SYNTHORG-BRIDGE";
pub const VERSION: &str = "1";

/// What a pairing code carries.
#[derive(Clone, PartialEq, Eq)]
pub struct PairingCode {
    /// The desktop's hidden I2P address, `<56 base32 chars>.b32.i2p`, lower case.
    pub address: String,
    /// The desktop's static X25519 public key (the Noise `rs`).
    pub public_key: [u8; 32],
    /// The one-time pre-shared key of this pairing.
    pub secret: [u8; 32],
    /// The X25519 private key this phone reads the desktop's encrypted leaseset with.
    pub reader_key: [u8; 32],
}

// The secret parts stay out of logs.
impl std::fmt::Debug for PairingCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingCode").field("address", &self.address).finish_non_exhaustive()
    }
}

impl Drop for PairingCode {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.secret.zeroize();
        self.reader_key.zeroize();
    }
}

/// Reads the code as scanned. Like the Node reference (`readCode` in
/// `scripts/bridge-phone.js`) it accepts base32 in either case.
pub fn parse(code: &str) -> Result<PairingCode> {
    let parts: Vec<&str> = code.trim().split(':').collect();
    if parts.len() != 6 || parts[0] != PREFIX {
        return Err(Error::Code("not a SynthOrg code".into()));
    }
    if parts[1] != VERSION {
        return Err(Error::Code(format!("unknown bridge version {}", parts[1])));
    }
    let address = parts[2].to_ascii_lowercase();
    // A hidden (blinded) address is 35 bytes: 56 base32 characters.
    if address.len() != 56 || !address.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)) {
        return Err(Error::Code("bad address".into()));
    }
    Ok(PairingCode {
        address: format!("{address}.b32.i2p"),
        public_key: key32(parts[3])?,
        secret: key32(parts[4])?,
        reader_key: key32(parts[5])?,
    })
}

fn key32(text: &str) -> Result<[u8; 32]> {
    let bytes = BASE32_NOPAD
        .decode(text.to_ascii_uppercase().as_bytes())
        .map_err(|_| Error::Code("bad base32".into()))?;
    bytes.try_into().map_err(|_| Error::Code("key is not 32 bytes".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b32(bytes: &[u8]) -> String {
        BASE32_NOPAD.encode(bytes)
    }

    fn sample() -> String {
        let address = "A".repeat(56);
        format!("SYNTHORG-BRIDGE:1:{address}:{}:{}:{}", b32(&[1; 32]), b32(&[2; 32]), b32(&[3; 32]))
    }

    #[test]
    fn parses_a_code() {
        let code = parse(&format!("  {}\n", sample())).unwrap();
        assert_eq!(code.address, format!("{}.b32.i2p", "a".repeat(56)));
        assert_eq!(code.public_key, [1; 32]);
        assert_eq!(code.secret, [2; 32]);
        assert_eq!(code.reader_key, [3; 32]);
        assert_eq!(b32(&[1; 32]).len(), 52);
    }

    #[test]
    fn accepts_lower_case_keys() {
        assert!(parse(&sample().to_lowercase().replacen("synthorg-bridge", "SYNTHORG-BRIDGE", 1)).is_ok());
    }

    #[test]
    fn rejects_bad_codes() {
        let good = sample();
        assert!(parse("hello").is_err());
        assert!(parse(&good.replacen("SYNTHORG-BRIDGE", "OTHER", 1)).is_err());
        assert!(parse(&good.replacen(":1:", ":2:", 1)).is_err());
        assert!(parse(&format!("{good}:extra")).is_err());
        // A key one byte short.
        assert!(parse(&good.replacen(&b32(&[1; 32]), &b32(&[1; 31]), 1)).is_err());
        // Characters outside the alphabet.
        assert!(parse(&good.replacen(&b32(&[2; 32]), &"1".repeat(52), 1)).is_err());
        assert!(parse(&good.replacen(&"A".repeat(56), &"A".repeat(55), 1)).is_err());
    }
}
