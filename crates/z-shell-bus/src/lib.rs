//! Bidirectional Unix domain socket bus server, ordered topic/command broker, and async Rust client.

pub mod client;
pub mod hub;
pub mod server;

pub use client::{BusClient, ClientError};
pub use hub::{BusHub, BusLimits, CallerContext, CommandCall, CommandHandler, UpdateKind};
pub use server::{BusError, BusServer, ShutdownHandle};
