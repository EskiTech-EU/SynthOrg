//! What travels on the stream, as `computer/server/bridge-noise.js` writes it.
//!
//! - Every block is a 2-byte big-endian length and that many bytes.
//! - The phone opens with a 1-byte block (the kind of link), then the three
//!   handshake messages, then only encrypted records.
//! - A record's plaintext is 1 flag byte (0: more pieces follow, 1: last
//!   piece) and at most 16 KiB of the message.
//! - A message is a 4-byte big-endian header length, the JSON header (UTF-8)
//!   and the body bytes, 24 MiB at most.

use crate::error::{Error, Result};
use crate::noise::{CipherState, Handshake, Keypair, Kind};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};

pub const BLOCK_MOST: usize = 65535;
pub const PIECE: usize = 16 * 1024;
pub const MESSAGE_MOST: usize = 24 * 1024 * 1024;

pub async fn read_block<R: AsyncRead + Unpin>(r: &mut R) -> Result<Vec<u8>> {
    let length = r.read_u16().await? as usize;
    let mut block = vec![0u8; length];
    r.read_exact(&mut block).await?;
    Ok(block)
}

pub async fn write_block<W: AsyncWrite + Unpin>(w: &mut W, block: &[u8]) -> Result<()> {
    if block.len() > BLOCK_MOST {
        return Err(Error::Channel("block too large".into()));
    }
    // One write for length and data: a stream carried by I2P sends what it is given as it comes.
    let mut out = Vec::with_capacity(2 + block.len());
    out.extend_from_slice(&(block.len() as u16).to_be_bytes());
    out.extend_from_slice(block);
    w.write_all(&out).await?;
    w.flush().await?;
    Ok(())
}

/// Header and body as one message. `header` is serialised in its field order
/// (serde keeps struct order), so a request comes out as Node's
/// `JSON.stringify({ t, id, method, params })` does.
pub fn encode_message<H: Serialize + ?Sized>(header: &H, body: &[u8]) -> Result<Vec<u8>> {
    let head = serde_json::to_vec(header).map_err(|e| Error::Channel(format!("header: {e}")))?;
    let mut message = Vec::with_capacity(4 + head.len() + body.len());
    message.extend_from_slice(&(head.len() as u32).to_be_bytes());
    message.extend_from_slice(&head);
    message.extend_from_slice(body);
    if message.len() > MESSAGE_MOST {
        return Err(Error::Channel("message too large".into()));
    }
    Ok(message)
}

/// The header (a JSON object) and the body of a whole message.
pub fn decode_message(mut message: Vec<u8>) -> Result<(Value, Vec<u8>)> {
    if message.len() < 4 {
        return Err(Error::Channel("message too short".into()));
    }
    let length = u32::from_be_bytes(message[..4].try_into().unwrap()) as usize;
    if 4 + length > message.len() {
        return Err(Error::Channel("header too long".into()));
    }
    let header: Value = serde_json::from_slice(&message[4..4 + length]).map_err(|_| Error::Channel("bad header".into()))?;
    if !header.is_object() {
        return Err(Error::Channel("bad header".into()));
    }
    let body = message.split_off(4 + length);
    Ok((header, body))
}

/// The reading half of an open channel.
pub struct ChannelReader<S> {
    r: ReadHalf<S>,
    cipher: CipherState,
}

/// The writing half of an open channel. Keep it behind one lock: the pieces of
/// a message must not interleave with another's.
pub struct ChannelWriter<S> {
    w: WriteHalf<S>,
    cipher: CipherState,
}

impl<S: AsyncRead + AsyncWrite> ChannelReader<S> {
    /// The next whole message.
    pub async fn receive(&mut self) -> Result<(Value, Vec<u8>)> {
        let mut message = Vec::new();
        loop {
            let block = read_block(&mut self.r).await?;
            let record = self.cipher.decrypt(&[], &block)?;
            let Some((&flag, data)) = record.split_first() else {
                return Err(Error::Channel("empty piece".into()));
            };
            message.extend_from_slice(data);
            if message.len() > MESSAGE_MOST {
                return Err(Error::Channel("message too large".into()));
            }
            match flag {
                1 => break,
                0 => continue,
                _ => return Err(Error::Channel("bad piece".into())),
            }
        }
        decode_message(message)
    }
}

impl<S: AsyncRead + AsyncWrite> ChannelWriter<S> {
    /// Sends a message already encoded with [`encode_message`], in pieces.
    pub async fn send_encoded(&mut self, message: &[u8]) -> Result<()> {
        if message.len() > MESSAGE_MOST {
            return Err(Error::Channel("message too large".into()));
        }
        let mut at = 0;
        loop {
            let end = (at + PIECE).min(message.len());
            let last = end >= message.len();
            let mut record = Vec::with_capacity(1 + end - at);
            record.push(if last { 1 } else { 0 });
            record.extend_from_slice(&message[at..end]);
            let block = self.cipher.encrypt(&[], &record)?;
            write_block(&mut self.w, &block).await?;
            if last {
                return Ok(());
            }
            at = end;
        }
    }

    pub async fn send<H: Serialize + ?Sized>(&mut self, header: &H, body: &[u8]) -> Result<()> {
        let message = encode_message(header, body)?;
        self.send_encoded(&message).await
    }

    /// Closes the stream: the peer sees the end.
    pub async fn shutdown(&mut self) {
        let _ = self.w.shutdown().await;
    }
}

/// The phone's side of the handshake on a stream just opened. `payload` is
/// what the phone says of itself in the third message.
pub async fn initiate<S>(
    stream: S,
    kind: Kind,
    s: Keypair,
    remote_static: [u8; 32],
    psk: Option<[u8; 32]>,
    payload: &[u8],
) -> Result<(ChannelReader<S>, ChannelWriter<S>, [u8; 32])>
where
    S: AsyncRead + AsyncWrite,
{
    let (mut r, mut w) = tokio::io::split(stream);
    let mut handshake = Handshake::initiator(kind, s, remote_static, psk)?;
    write_block(&mut w, &[kind.byte()]).await?;
    write_block(&mut w, &handshake.write(&[])?).await?;
    handshake.read(&read_block(&mut r).await?)?;
    write_block(&mut w, &handshake.write(payload)?).await?;
    let hash = handshake.hash();
    let (send, receive) = handshake.split()?;
    Ok((ChannelReader { r, cipher: receive }, ChannelWriter { w, cipher: send }, hash))
}

/// The desktop's side, for tests: returns the channel, the kind, the phone's key and its payload.
pub async fn respond<S>(
    stream: S,
    s: Keypair,
    psk: Option<[u8; 32]>,
) -> Result<(ChannelReader<S>, ChannelWriter<S>, Kind, [u8; 32], Vec<u8>)>
where
    S: AsyncRead + AsyncWrite,
{
    let (mut r, mut w) = tokio::io::split(stream);
    let first = read_block(&mut r).await?;
    let kind = match first.as_slice() {
        [1] => Kind::Session,
        [2] => Kind::Pairing,
        _ => return Err(Error::Channel("unknown kind of link".into())),
    };
    let mut handshake = Handshake::responder(kind, s, psk)?;
    handshake.read(&read_block(&mut r).await?)?;
    write_block(&mut w, &handshake.write(&[])?).await?;
    let payload = handshake.read(&read_block(&mut r).await?)?;
    let remote = handshake.remote_static().expect("known after message 3");
    let (send, receive) = handshake.split()?;
    Ok((ChannelReader { r, cipher: receive }, ChannelWriter { w, cipher: send }, kind, remote, payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_round_trip() {
        let m = encode_message(&json!({"t": "evt", "name": "x"}), b"body").unwrap();
        assert_eq!(&m[..4], &(m.len() as u32 - 4 - 4).to_be_bytes());
        let (header, body) = decode_message(m).unwrap();
        assert_eq!(header["name"], "x");
        assert_eq!(body, b"body");
        assert!(decode_message(vec![0, 0, 0, 9, b'{', b'}']).is_err());
        assert!(decode_message([&[0, 0, 0, 2][..], b"[]"].concat()).is_err());
        assert!(encode_message(&json!({}), &vec![0; MESSAGE_MOST]).is_err());
    }

    #[tokio::test]
    async fn channel_carries_big_messages_in_pieces() {
        let (a, b) = tokio::io::duplex(1 << 16);
        let desktop = Keypair::generate();
        let desktop_public = desktop.public;
        let phone = Keypair::generate();
        let phone_public = phone.public;
        let server = tokio::spawn(async move {
            let (mut r, mut w, kind, remote, payload) = respond(b, desktop, None).await.unwrap();
            assert_eq!(kind, Kind::Session);
            assert_eq!(remote, phone_public);
            assert_eq!(payload, b"{}");
            let (header, body) = r.receive().await.unwrap();
            w.send(&header, &body).await.unwrap();
        });
        let (mut r, mut w, _) = initiate(a, Kind::Session, phone, desktop_public, None, b"{}").await.unwrap();
        let body: Vec<u8> = (0..100_000u32).map(|i| i as u8).collect();
        w.send(&json!({"t": "req", "id": 1}), &body).await.unwrap();
        let (header, echoed) = r.receive().await.unwrap();
        assert_eq!(header["id"], 1);
        assert_eq!(echoed, body);
        server.await.unwrap();
    }
}
