use crate::{senpi_grep_abi_sentinel, NATIVE_GREP_ABI_VERSION};

#[test]
fn abi_sentinel_matches_abi_version() {
    assert_eq!(senpi_grep_abi_sentinel(), NATIVE_GREP_ABI_VERSION);
}
