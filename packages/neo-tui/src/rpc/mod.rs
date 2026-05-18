//! RPC client: subprocess `senpi --mode rpc` + JSONL line codec.
//!
//! - [`envelope`] - wire-level `type: response` / `type: event` discriminator
//! - [`command`]  - typed commands sent on the child's stdin
//! - [`event`]    - typed events parsed from the child's stdout
//! - [`client`]   - tokio subprocess wrapper with bidirectional channels

pub mod client;
pub mod command;
pub mod envelope;
pub mod event;

pub use client::{ClientError, Inbound, RpcClient};
