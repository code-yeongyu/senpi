# Bun 1.4 Performance

Blog: [#production](https://bun.com/blog/bun-v1.4#production), [#faster](https://bun.com/blog/bun-v1.4#faster)

All of this is free — no code changes. Use these numbers when justifying a Bun 1.4 upgrade.

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
