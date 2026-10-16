//! One error type for the whole crate.
//!
//! The kinds mirror the `code` values the Node side puts on its errors,
//! because the retry rules depend on them: a stream the router could not open
//! (`Unreachable`) is tried again, a channel that proved false (`Channel`) is
//! never tried again, a stream that just went quiet or closed is.

use std::fmt;

#[derive(Debug)]
pub enum Error {
    /// The pairing code is not a SynthOrg code, or not one this version reads.
    Code(String),
    /// The SAM interface refused or did not answer (Node: BRIDGE_ROUTER).
    Router(String),
    /// STREAM CONNECT failed, e.g. CANT_REACH_PEER (Node: BRIDGE_UNREACHABLE).
    Unreachable(String),
    /// The encrypted channel failed a check: wrong key, forged record,
    /// malformed message (Node: BRIDGE_CHANNEL). Never retried.
    Channel(String),
    /// The stream closed (Node: BRIDGE_CLOSED).
    Closed,
    /// Nothing arrived in time.
    Timeout(String),
    /// The desktop answered a request with `ok: false`.
    Remote { code: String, message: String },
    /// A call was made while no channel is open.
    NotConnected,
    /// `connect` before `pair`: there is no identity to connect with.
    NotPaired,
    Io(std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Whether the handshake may be tried again on a new stream (Node: anything but BRIDGE_CHANNEL).
    pub(crate) fn is_channel(&self) -> bool {
        matches!(self, Error::Channel(_))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Code(m) => write!(f, "invalid pairing code: {m}"),
            Error::Router(m) => write!(f, "I2P router: {m}"),
            Error::Unreachable(m) => write!(f, "desktop unreachable: {m}"),
            Error::Channel(m) => write!(f, "channel: {m}"),
            Error::Closed => write!(f, "connection closed"),
            Error::Timeout(m) => write!(f, "timeout: {m}"),
            Error::Remote { code, message } => write!(f, "{code}: {message}"),
            Error::NotConnected => write!(f, "not connected"),
            Error::NotPaired => write!(f, "phone not paired yet"),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        // A stream that ends mid-block is the same event as one that closes between blocks.
        match e.kind() {
            std::io::ErrorKind::UnexpectedEof
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::BrokenPipe => Error::Closed,
            _ => Error::Io(e),
        }
    }
}
