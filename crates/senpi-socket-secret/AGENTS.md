# crates/senpi-socket-secret

Rust/N-API Windows adapter for the socket-secret lifecycle of sisyphuslabs/omo-desktop-app#4199: the storage-locality classification and the kernel-session identity that decide when presence-lock and process evidence may count.

## STRUCTURE

```text
src/answers.rs            Revision 8.2/8.3 raw query answers -> facts; the exact accepted codes, raw codes kept
src/classify.rs           Pure Revision 8 locality rule over the volume facts (unit-tested with fakes)
src/session.rs            PID-4 creation FILETIME; `Unverified` never matches anything
src/volume.rs             Volume facts read from ONE handle that follows reparse points
src/presence.rs           Presence guards: lock outcome rule, registry (no unlock while active), sticky pre-action fence
src/presence_windows.rs   LockFileEx on byte [0,1) of an EXISTING object; overlapped wait cancelled by CancelIoEx
src/presence_binding.rs   Process-rooted N-API registry, admissible retained probes, cancellable worker waits
src/presence_placement.rs Presence root open/create (canonical path, identity, locality from one handle), FILE_CREATE
                          of a predeclared object relative to the verified root, FOLDERID_LocalAppData
src/publish.rs            First publication: CREATE_NEW staging with the owner-only DACL, flush, FileRenameInfo ReplaceIfExists=FALSE
src/owner_dacl.rs         Protected DACL for the current user, SYSTEM and Administrators
src/lib.rs                N-API exports and the `__senpiSocketSecretAbi1` ABI sentinel
tests/native_receipts.rs  Native receipts 27 and 28; real Windows only
tests/native_presence.rs  Presence-guard receipts (contention, release, blocking wait, cancel); real Windows only
tests/native_presence_binding.rs  Native binding: busy/admissible probes and quiescence; typed unavailable off Windows
tests/native_presence_placement.rs  Root/object creation, never-replace, identity mismatch; typed unavailable off Windows
```

## CONTRACTS

- Locality comes from the kernel driver in the volume's I/O path (`FileFsDriverPathInformation`), never from the reported file-system name alone. Local needs the full conjunction (driver in path, `FILE_REMOTE_DEVICE` clear, no remote-protocol information, neither driver query failed). Any query failure, from either driver query included, is `not_local`; only the exact codes in `src/answers.rs` (design Revisions 8.2/8.3) are answers, and a new code joins that list only with a primary-source meaning and a receipt.
- The classifying handle follows reparse points. Never open it with `FILE_FLAG_OPEN_REPARSE_POINT`.
- `SessionIdentity` has no `PartialEq` on purpose; compare with `same_session`, under which `Unverified` matches nothing.
- A presence guard proves release only by a successful exclusive acquisition; `ERROR_LOCK_VIOLATION` is occupied and every other failure is unknown. A guard leaves the registry only with a quiescence receipt, a failed pre-action check fences the registry permanently, and a missing presence object is never recreated.
- Publication never writes the final path, never copies or truncates, and a collision is only ERROR_ALREADY_EXISTS/ERROR_FILE_EXISTS. One handle (`GENERIC_WRITE | DELETE`, share read only) writes, flushes and renames the staging file, and on any outcome but `Published` deletes it through that handle; nothing is reopened or deleted by path. A failed delete is part of the result (`Publication::staging_left_behind`, N-API `stagingLeftBehind { path, windowsError }`), never a log line, and never carries the bytes.
- Windows x64/arm64 prebuilds and the headless `socket-secret-native.ts` loader are wired by the packaging change. Presence exports return typed `unavailable` off Windows; the POSIX lifetime contract is not implemented.
- Presence objects are created only with `FILE_CREATE` relative to a root handle whose recorded identity and `local` classification were just checked; an existing name is `exists`. Nothing here renames, truncates, replaces or deletes one. Choosing and recording the root is the TypeScript caller's job (`presence-placement.ts`).
- Probe busy means occupied before any admissibility check. A successful probe retains the guard only when the persisted tag/file identity, creation/current locality, and (for relocated objects) verified kernel session match. Inadmissible success is unknown and closes immediately. JS GC never releases the process-rooted registry; release requires a caller-committed `released` receipt after quiescence.

## VALIDATION

- `cargo test -p senpi-socket-secret --locked` (classifier and session units on every host; the receipts are ignored off Windows).
- Native receipts run only in `ci.yml` `socket-secret-native-windows`, which mounts the WinFsp, Dokany, SMB and VHDX fixtures and runs the ignored cases; its `RECEIPT_` lines are the receipt. Never run them in a VM.
