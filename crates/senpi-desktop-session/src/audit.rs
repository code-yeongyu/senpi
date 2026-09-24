//! The `audit` record of one mutating request. Typed text is never audited:
//! only its length and the first 16 hex digits of its SHA-256.

use std::fmt::Write as _;
use std::time::Duration;

use senpi_desktop_core::backend::DeliveryMode;
use senpi_desktop_core::error::ErrorCode;
use senpi_desktop_core::protocol_results::AuditEvent;
use sha2::{Digest, Sha256};

use crate::mutate::Mutation;

/// Hex digits of the text digest kept in the audit.
const TEXT_SHA256_HEX_DIGITS: usize = 16;

pub(crate) fn audit_event(
    mutation: &Mutation<'_>,
    code: Option<ErrorCode>,
    focus_restored: Option<bool>,
    elapsed: Duration,
) -> AuditEvent {
    AuditEvent {
        action: mutation.action.method(),
        target: mutation.target.clone(),
        delivery: match mutation.delivery {
            DeliveryMode::Background => "background",
            DeliveryMode::Foreground => "foreground",
        }
        .to_owned(),
        frame_id: mutation.frame_id.map(str::to_owned),
        code,
        duration_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        focus_restored,
        text_length: mutation
            .text
            .map(|text| u32::try_from(text.chars().count()).unwrap_or(u32::MAX)),
        text_sha256: mutation.text.map(text_sha256_prefix),
        keys: mutation.keys.map(<[String]>::to_vec),
    }
}

fn text_sha256_prefix(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(TEXT_SHA256_HEX_DIGITS);
    for byte in digest.iter().take(TEXT_SHA256_HEX_DIGITS / 2) {
        // Writing to a `String` cannot fail.
        write!(hex, "{byte:02x}").unwrap_or(());
    }
    hex
}
