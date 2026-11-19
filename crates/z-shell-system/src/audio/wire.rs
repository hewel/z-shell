//! PulseAudio pstream framing and tagstruct scalars. Layouts from PulseAudio's
//! `src/pulsecore/{pstream,tagstruct}.c`; control packets never use shared memory.

use std::io;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

const HEADER: usize = 20;
const CONTROL_CHANNEL: u32 = u32::MAX;
const MAX_PACKET: usize = 16 * 1024 * 1024;
const MAX_CHANNELS: usize = 32;

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("audio socket I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("invalid PulseAudio control packet")]
    Protocol,
    #[error("unsupported PulseAudio protocol version {0}")]
    Version(u32),
    #[error("PulseAudio rejected the request (code {0})")]
    Rejected(u32),
    #[error("PulseAudio request timed out")]
    Timeout,
}

pub(super) type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Default)]
pub(super) struct Packet(Vec<u8>);

impl Packet {
    pub(super) fn reset(&mut self, command: u32, tag: u32) {
        self.0.clear();
        self.0.extend_from_slice(&[0; HEADER]);
        self.u32(command);
        self.u32(tag);
    }

    pub(super) fn u32(&mut self, value: u32) {
        self.0.push(b'L');
        self.0.extend_from_slice(&value.to_be_bytes());
    }

    pub(super) fn string(&mut self, value: Option<&str>) {
        if let Some(value) = value {
            self.0.push(b't');
            self.0.extend_from_slice(value.as_bytes());
            self.0.push(0);
        } else {
            self.0.push(b'N');
        }
    }

    pub(super) fn bytes(&mut self, value: &[u8]) {
        self.0.push(b'x');
        self.0
            .extend_from_slice(&(value.len() as u32).to_be_bytes());
        self.0.extend_from_slice(value);
    }

    pub(super) fn boolean(&mut self, value: bool) {
        self.0.push(if value { b'1' } else { b'0' });
    }

    pub(super) fn volume(&mut self, channels: u8, value: u32) {
        self.0.extend_from_slice(&[b'v', channels]);
        let bytes = value.to_be_bytes();
        for _ in 0..channels {
            self.0.extend_from_slice(&bytes);
        }
    }

    pub(super) fn application(&mut self, name: &str) {
        self.0.push(b'P');
        self.string(Some("application.name"));
        let len = (name.len() + 1) as u32;
        self.u32(len);
        self.0.push(b'x');
        self.0.extend_from_slice(&len.to_be_bytes());
        self.0.extend_from_slice(name.as_bytes());
        self.0.extend_from_slice(b"\0N");
    }

    pub(super) async fn send(&mut self, socket: &mut UnixStream) -> Result<()> {
        let length = (self.0.len() - HEADER) as u32;
        self.0[..4].copy_from_slice(&length.to_be_bytes());
        self.0[4..8].copy_from_slice(&CONTROL_CHANNEL.to_be_bytes());
        socket.write_all(&self.0).await?;
        Ok(())
    }
}

pub(super) async fn receive(
    socket: &mut UnixStream,
    buf: &mut Vec<u8>,
    first: Option<u8>,
) -> Result<()> {
    let mut header = [0; HEADER];
    if let Some(first) = first {
        header[0] = first;
        socket.read_exact(&mut header[1..]).await?;
    } else {
        socket.read_exact(&mut header).await?;
    }
    let mut fields = Reader(&header);
    let length = fields.raw_u32()? as usize;
    if !(10..=MAX_PACKET).contains(&length)
        || fields.raw_u32()? != CONTROL_CHANNEL
        || fields.take(12)? != [0; 12]
    {
        return Err(Error::Protocol);
    }
    buf.resize(length, 0);
    socket.read_exact(buf).await?;
    Ok(())
}

pub(super) struct Reader<'a>(pub(super) &'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let (value, rest) = self.0.split_at_checked(len).ok_or(Error::Protocol)?;
        self.0 = rest;
        Ok(value)
    }

    fn raw_u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| Error::Protocol)?,
        ))
    }

    fn tag(&mut self, tag: u8) -> Result<()> {
        if self.take(1)? == [tag] {
            Ok(())
        } else {
            Err(Error::Protocol)
        }
    }

    pub(super) fn empty(&self) -> bool {
        self.0.is_empty()
    }

    pub(super) fn end(&self) -> Result<()> {
        if self.empty() {
            Ok(())
        } else {
            Err(Error::Protocol)
        }
    }

    pub(super) fn u32(&mut self) -> Result<u32> {
        self.tag(b'L')?;
        self.raw_u32()
    }

    pub(super) fn u8(&mut self) -> Result<u8> {
        self.tag(b'B')?;
        Ok(self.take(1)?[0])
    }

    pub(super) fn string(&mut self) -> Result<Option<&'a str>> {
        match self.take(1)?[0] {
            b'N' => Ok(None),
            b't' => {
                let end = self.0.iter().position(|&b| b == 0).ok_or(Error::Protocol)?;
                let value = self.take(end + 1)?;
                std::str::from_utf8(&value[..end])
                    .map(Some)
                    .map_err(|_| Error::Protocol)
            }
            _ => Err(Error::Protocol),
        }
    }

    fn bytes(&mut self) -> Result<&'a [u8]> {
        self.tag(b'x')?;
        let len = self.raw_u32()? as usize;
        self.take(len)
    }

    pub(super) fn boolean(&mut self) -> Result<bool> {
        match self.take(1)?[0] {
            b'0' => Ok(false),
            b'1' => Ok(true),
            _ => Err(Error::Protocol),
        }
    }

    pub(super) fn sample_spec(&mut self) -> Result<()> {
        self.tag(b'a')?;
        self.take(6)?;
        Ok(())
    }

    pub(super) fn channel_map(&mut self) -> Result<()> {
        self.tag(b'm')?;
        let channels = usize::from(self.take(1)?[0]);
        if channels > MAX_CHANNELS {
            return Err(Error::Protocol);
        }
        self.take(channels)?;
        Ok(())
    }

    pub(super) fn channel_volume(&mut self) -> Result<(u8, u32)> {
        self.tag(b'v')?;
        let channels = self.take(1)?[0];
        if usize::from(channels) > MAX_CHANNELS {
            return Err(Error::Protocol);
        }
        let mut sum = 0_u64;
        for _ in 0..channels {
            sum += u64::from(self.raw_u32()?);
        }
        // Some non-PCM streams have zero volume channels.
        let average = sum / u64::from(channels.max(1));
        Ok((channels, average as u32))
    }

    pub(super) fn usec(&mut self) -> Result<()> {
        self.tag(b'U')?;
        self.take(8)?;
        Ok(())
    }

    pub(super) fn scalar_volume(&mut self) -> Result<()> {
        self.tag(b'V')?;
        self.take(4)?;
        Ok(())
    }

    pub(super) fn properties(&mut self) -> Result<Option<&'a str>> {
        self.tag(b'P')?;
        let mut application = None;
        while let Some(key) = self.string()? {
            let len = self.u32()? as usize;
            let value = self.bytes()?;
            if len != value.len() {
                return Err(Error::Protocol);
            }
            if application.is_none() && key == "application.name" {
                application = value
                    .strip_suffix(b"\0")
                    .and_then(|value| std::str::from_utf8(value).ok())
                    .filter(|value| !value.is_empty() && !value.contains('\0'));
            }
        }
        Ok(application)
    }

    pub(super) fn format(&mut self) -> Result<()> {
        self.tag(b'f')?;
        self.u8()?;
        self.properties()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_reject_truncation() {
        let mut packet = Packet::default();
        packet.reset(7, 9);
        packet.application("z-shell ♫");
        packet.volume(3, 65536);
        packet.boolean(true);
        packet.string(None);
        packet.bytes(b"\x00\xff");
        let mut read = Reader(&packet.0[HEADER..]);
        assert_eq!(read.u32().unwrap(), 7);
        assert_eq!(read.u32().unwrap(), 9);
        assert_eq!(read.properties().unwrap(), Some("z-shell ♫"));
        assert_eq!(read.channel_volume().unwrap(), (3, 65536));
        assert!(read.boolean().unwrap());
        assert_eq!(read.string().unwrap(), None);
        assert_eq!(read.bytes().unwrap(), b"\x00\xff");
        read.end().unwrap();
        assert!(matches!(
            Reader(b"v\x02\0\0\0\0").channel_volume(),
            Err(Error::Protocol)
        ));
        assert!(matches!(Reader(b"tabc").string(), Err(Error::Protocol)));
    }
}
