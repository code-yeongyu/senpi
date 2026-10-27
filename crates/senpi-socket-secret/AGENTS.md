# crates/senpi-socket-secret

Rust/N-API Windows adapter for the socket-secret lifecycle of sisyphuslabs/omo-desktop-app#4199: the storage-locality classification and the kernel-session identity that decide when presence-lock and process evidence may count.

## STRUCTURE

```text
src/answers.rs            Revision 8.2/8.3 raw query answers -> facts; the exact accepted codes, raw codes kept
src/classify.rs           Pure Revision 8 locality rule over the volume facts (unit-tested with fakes)
src/process_identity.rs   Pure observation table: a reopened PID is Live, Gone or Unknown against its record
src/process_handle.rs     Retained non-inheritable process handle: PID, creation FILETIME, TokenUser SID, exit wait
src/session.rs            PID-4 creation FILETIME; `Unverified` never matches anything
src/volume.rs             Volume facts read from ONE handle that follows reparse points
src/lib.rs                N-API exports and the `__senpiSocketSecretAbi1` ABI sentinel
tests/native_receipts.rs  Native receipts 27 and 28; real Windows only
tests/native_process_receipts.rs  Actual-target identity receipts on a real child process; real Windows only
```

## CONTRACTS

- Locality comes from the kernel driver in the volume's I/O path (`FileFsDriverPathInformation`), never from the reported file-system name alone. Local needs the full conjunction (driver in path, `FILE_REMOTE_DEVICE` clear, no remote-protocol information, neither driver query failed). Any query failure, from either driver query included, is `not_local`; only the exact codes in `src/answers.rs` (design Revisions 8.2/8.3) are answers, and a new code joins that list only with a primary-source meaning and a receipt.
- The classifying handle follows reparse points. Never open it with `FILE_FLAG_OPEN_REPARSE_POINT`.
- A process record is PID + full creation FILETIME + TokenUser SID read on ONE handle; a different readable creation time is Gone, every unreadable or inconsistent answer is Unknown, and Gone never authorizes signalling the PID's current holder.
- `SessionIdentity` has no `PartialEq` on purpose; compare with `same_session`, under which `Unverified` matches nothing.
- Prebuilds and the loader are not wired yet; this crate ships no artifact until the packaging change lands.

## VALIDATION

- `cargo test -p senpi-socket-secret --locked` (classifier and session units on every host; the receipts are ignored off Windows).
- Native receipts run only in `ci.yml` `socket-secret-native-windows`, which mounts the WinFsp, Dokany, SMB and VHDX fixtures and runs the ignored cases; its `RECEIPT_` lines are the receipt. Never run them in a VM.
