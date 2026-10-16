//! The phone side of SynthOrg's bridge (see `computer/docs/ponte-telefono.md`).
//!
//! - [`code`]: the pairing code of the QR code
//! - [`sam`]: the I2P router's SAM interface
//! - [`noise`]: the Noise XKhfs + ML-KEM-768 handshake
//! - [`wire`]: blocks, encrypted records, messages
//! - [`client`]: [`Phone`], what the app uses

pub mod client;
pub mod code;
pub mod error;
pub mod noise;
pub mod sam;
pub mod wire;

pub use client::{ConnState, Event, Identity, NetSession, Network, PairedDesktop, Phone, PhoneConfig, Via, Welcome};
pub use error::{Error, Result};
pub use sam::{Sam, SamConfig};
