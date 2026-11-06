# Bun 1.4.x Performance

Blog: [#production](https://bun.com/blog/bun-v1.4#production), [#faster](https://bun.com/blog/bun-v1.4#faster), then the 1.4.1/1.4.3/1.4.4 posts

All of this is free — no code changes. Use these numbers when justifying a Bun upgrade; measure with `proc.resourceUsage()` / `process.memoryUsage().rss` (see [session-recipes](session-recipes.md)), and remember that `--cpu-prof-md` credits idle gaps to the last sampled frame — count samples before filing a hotspot (2026-10-17).

## Since 1.4.0 (point releases)

- 1.4.1: JIT code is dropped after an idle period — Next.js SSR idle RSS 222 MB → 142 MB; `AsyncLocalStorage.run` 2x faster with no per-`await` allocation; `Buffer` read/write up to 9x; first HTTPS request 3x faster (DER-embedded roots); `Bun.inspect` on 16k-key objects 43x; compiled executables start 20% faster and bytecode is 3x smaller.
- 1.4.3: idle CPU down 67-89% (the GC timer no longer wakes every second); `Promise.allSettled` over 100k rejections 24 s → 148 ms; `JSON.parse` 1.2-1.5x on registry-shaped data; `node:http` large responses up to 2.7x; `Bun.gc(true)` returns memory to the OS immediately; `crypto.randomInt`, small zstd/zlib and `Bun.color` regressions from 1.4.0 recovered.
- 1.4.4: `bun check` 1.4-7.8x faster (`-b` up to 15x); hoisted installs from a warm cache 3.2x on Linux; `Bun.SQL` 21-48% less client CPU; `toLocaleString()` 54x; `Headers` iteration up to 2.8x; in-memory `response.body` streams up to 2.6x; `Bun.Glob.match` 1.6-5x; `Bun.JSON5.parse` 1.6x.

## Production footprint

- **Allocator unified**: JavaScriptCore now uses mimalloc (extended with partial page clearing, an idle-time scavenger thread, lazy zeroing).
- **CPU**: Claude Code production CPU dropped 2x (p99 24%→10%, p50 5.8%→2.5%); hello-world idle CPU 5x lower.
- **Memory under load** (1M requests): fastify −48% (120MB), Express −46% (92MB), node:http −40% (81MB), Elysia −40%, Next.js −28%, Bun.serve −20% (36MB). Next.js App Router SSR that grew unbounded in 1.3 settles at 238MB (Node: 410MB).
- **Startup**: Windows 15.5ms (2.5x faster, was 39ms; Node 40ms); Linux 5.1ms (2x faster; Node 27.2ms) with peak memory 14.6MB vs Node 44.5MB.
- **Binary size**: Linux/Windows ~17% smaller (77MB Linux x64).

## Runtime speedups (WebKit pin bumped 39 times = ~8 months of JSC work)

| What | Improvement |
|---|---|
| `new URL()` | up to 4.6x faster (75ns vs Node 232ns); `url.href` 5ns |
| RegExp (JSC-vs-V8 gap fixed) | `marked.parse()` 138x faster (912ms→6ms on 80KB); `isbot` 200x faster |
| `node:zlib` → zlib-ng | decompression ~20% faster across the board; peak memory 25-35MB lower; runtime CPU dispatch |
| `Buffer.from(str, "hex")` | 8x faster (SIMD); `"base64url"` 46x faster |
| Source map decoding | 3.1x faster (SIMD); 24x faster than Node on a 9.5MB map |
| Promises (JSC rewrite) | 1.5-2.4x faster; `await` resolved 84ns; 1M pending promises: 251MB peak (was 668MB), settle 12.5ms (was 39ms) |

## Streams, bodies, backpressure

The Production section of the blog also covers stream/body handling and backpressure improvements in `Bun.serve` — notably `server.publish()`/`ws.publish()` now report drops (`0`) and backpressure (`-1`) honestly; see [http-networking](http-networking.md).

## Windows-specific

- Timers no longer round to the 15.6ms system tick: `setTimeout(fn, 1)` fires in ~1.4ms.
- Startup 2.5x faster; runs inside an AppContainer sandbox; works on read-only directories/shares.
