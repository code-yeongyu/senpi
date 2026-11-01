<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-11-01 - the host binds and reads its endpoint without ever following a symlink there (senpi#5319)

### What changed

- `packages/coding-agent/src/modes/rpc/host-socket-bind.ts`: `listen` binds the socket inside a fresh 0700 directory created beside the endpoint (same filesystem, named to keep the bind path within `MAX_SOCKET_PATH_BYTES`), sets it 0600, and publishes it at the endpoint with `link(2)`, then removes the bind directory. `link(2)` is atomic, never follows the new name, and fails `EEXIST` on any entry that took the endpoint after `prepareSocketPath` freed it (a planted symlink or a live socket); that refuses the start ("address already in use (an entry took the endpoint before the bind was published)"), closes the listener and leaves the entry untouched. It returns the identity of the published entry. Windows named pipes and Linux abstract sockets bind directly as before.
- `packages/coding-agent/src/modes/rpc/host-lifecycle-proxy.ts`: the supervisor's `listen` delegates to that bind. `prepareSocketPath` refuses a non-socket entry (a symlink or a regular file) as "address already in use, occupied by a non-socket entry (a symlink or other file; nothing listens there)" instead of naming a live server that does not exist.
- `packages/coding-agent/src/modes/rpc/socket-ownership.ts`: `statSocketIdentity` reads with `lstat`. A symlink at a socket path answers with its own identity, which never matches a bound socket's, so ownership classification reads it as another entry (`replaced`), `unlinkOwnedSocket` leaves it, and `adoptPublicSocket` refuses to replace it. A real socket's identity is unchanged.

### Why

- On macOS `bind(2)` follows a dangling symlink at the endpoint and creates the socket at the link's target, so a link planted between `prepareSocketPath` and the bind moved the host's listener to a path the planter chose while clients connected to the link. Linux refuses that bind with `EADDRINUSE`, and both platforms refuse `link(2)` onto any existing entry. `rename(2)` was not used for the publish because it silently replaces a live socket that took the name, which would remove an endpoint this host never probed (#5283, #5314). `statSocketIdentity` followed links with `stat`, so a link to a host's own socket read as that socket and teardown could unlink the link entry by path.

### Why an extension could not handle it

- The bind and the ownership reads run inside the lifecycle supervisor and the socket host before any session or extension exists.

### Expected merge conflict zones

- LOW: `listen` in `host-socket-bind.ts` and `host-lifecycle-proxy.ts`, the non-socket refusal in `prepareSocketPath`, and `statSocketIdentity` in `socket-ownership.ts`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Fixed
- An RPC host never binds through a symlink planted at its socket path (macOS followed it and listened at the link's target), and its ownership checks read a symlink there as a foreign entry instead of the socket it names ([#5319](https://github.com/code-yeongyu/senpi/issues/5319))
