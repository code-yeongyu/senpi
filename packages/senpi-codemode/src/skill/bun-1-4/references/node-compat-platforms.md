# Node.js Compatibility & Platforms (Bun 1.4)

Blog: [#node-js-compatibility](https://bun.com/blog/bun-v1.4#node-js-compatibility), [#platforms](https://bun.com/blog/bun-v1.4#platforms) · Live tracker: <https://bun.com/node-test-suite>

Bun 1.4 reports **Node.js 26** (`process.versions.modules` = 147). 3,743 Node test-suite files pass (+1,517 since 1.3). `node:http`, `node:fs`, `node:cluster`, `node:timers`, `node:zlib`, `node:vm`, `node:stream` pass 97% of Node's own tests; `node:quic` 99%; `node:events`, `node:trace_events`, `node:sqlite` 100%.

## Big frameworks/tools that now run on Bun

- **Playwright** [v1.4.0]: `connectOverCDP()`, `playwright test` with config, `--ui`, Chromium on Windows.
- **Next.js 16** [v1.3.2]: `bun --bun next build` works on 16.3 with Turbopack + React Compiler.
- **vitest** [v1.4.0]: runs under Bun including `--coverage`, threads and forks pools.
- **OpenTelemetry** [v1.4.0]: http/fs instrumentation export spans; shimmer + require-in-the-middle patch bundled code.
- **dd-trace** [v1.4.0]: traces + `@datadog/pprof` continuous profiling (V8 C++ APIs implemented).

## Newly working packages

Nuxt (`nuxt dev` HMR + DevTools), testcontainers/dockerode (`container.exec()`), https-proxy-agent / socks-proxy-agent, crawlee (proxy-chain), @grpc/grpc-js + ConnectRPC (behind Envoy/ALB), amqplib (RabbitMQ), @aws-sdk/client-s3 streaming uploads, TypeORM (tsconfig decorator settings), nock, Fastify `inject()` / light-my-request, happy-dom, piscina.

## New Node.js APIs in Bun

- `worker_threads`: `resourceLimits`, `stdout`, `stderr`, `eval` options.
- ws: `'upgrade'` and `'unexpected-response'` events.
- `socket.upgradeTLS({ isServer: true })`: server-side STARTTLS.
- `node:cluster` shares listening sockets between workers.
- `node:repl`, `node:trace_events`, `node:domain`: implemented.

## Platforms

| Platform | Status |
|---|---|
| FreeBSD x86_64/aarch64 [v1.3.14] | Official native builds; full runtime on stock FreeBSD 14.3+ (native port, not Linux compat layer) |
| Windows ARM64 [v1.3.7] | Native builds (Surface, Snapdragon X, Ampere) |
| Android aarch64/x64 [v1.4.0] | Experimental builds with every release |
| Linux glibc 2.17 [v1.3.13] | Minimum dropped from 2.26 — RHEL/CentOS 7, Amazon Linux 1 work; kernel minimum 3.10 (`memfd_create` fallback) |
| Windows | Sub-15ms timers (no 15.6ms tick rounding); runs in AppContainer; read-only directories OK |
| TypeScript 7 | `bun init` templates + `@types/bun` are TS7-ready; `bun init` writes `typescript ^7` |
