# changes

## 2026-09-12 - Keep explicit Buffer typing in the Unix socket transport

### What changed

- `packages/client/src/unix.ts`: the `socket.on("data", ...)` handler in `connectUnixSocket` annotates its chunk as `Buffer` before it is re-wrapped as a `Uint8Array`. Upstream's `createUnixTransportFactory` and `discoverUnixServers` are kept unchanged otherwise.

### Why

- The fork compiles this package with its own strict TypeScript settings, where the untyped `data` listener parameter widens to `any` and trips the no-implicit-any gate. The explicit type keeps the workspace build green without changing runtime behavior.

### Why an extension could not handle it

- This is a type annotation inside the client transport source; extensions can't reach into a library package's compile step.

### Expected merge conflict zones

- The `socket.on("data", ...)` listener inside `connectUnixSocket` in `packages/client/src/unix.ts` whenever upstream reshapes the Unix transport (service discovery, bounded runtime paths, or rename of server IDs).

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/client/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/client/package.json.
