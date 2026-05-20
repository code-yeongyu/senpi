#![allow(
    clippy::redundant_pub_crate,
    reason = "frame items are pub(crate)-scoped; module itself is pub(crate) in lib.rs"
)]
#![allow(
    unused_imports,
    reason = "FrameRequester re-export is consumed by app integration in a follow-up change"
)]

pub(crate) mod rate_limiter;
pub(crate) mod requester;

pub(crate) use requester::FrameRequester;
