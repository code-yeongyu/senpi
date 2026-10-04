# Vendored: @earendil-works/pi-codemode 1.0.1

- Upstream: https://github.com/earendil-works/pi, directory `packages/codemode/src`
- Tag `v1.0.1`, commit `a7229ddc21810d6245105978033b7df645ecc2f7` (`packages/codemode/package.json` version 1.0.1)
- License: MIT, upstream `LICENSE` copied unchanged beside this file.
- Why vendored: the published package ships compiled `dist` only, and senpi needs three host changes that are not in any release (listed below once they land). Vendoring the source keeps them in this repository, so a registry consumer receives them.

## Provenance

Building `packages/codemode` at that commit with its pinned compiler (`typescript` 7.0.2, `tsc -p tsconfig.build.json`) reproduces all 40 files of the published npm `@earendil-works/pi-codemode@1.0.1` `dist` byte for byte, so this source is the released code.

Each file below is the upstream file unchanged, with only the two-line attribution header added at the top. The SHA-256 is of the upstream file, which is this file minus its first two lines.

| file | upstream SHA-256 |
| --- | --- |
| `runtime/host.ts` | `b81e1bb07f3cd7e612c5ed03b6d23929acf3738be764c0741b85306d8221c522` |
| `runtime/worker.ts` | `f2e4854de6c9713390148a7d02b35e753065aca42c759ca14676f90f937f0a8a` |
| `runtime/prelude-source.ts` | `bd544106d5bd36543be4e5fc21128c9cd46b26856fb0b17931250b955f93c24a` |
| `runtime/protocol.ts` | `b5150df8e6c743f99a94f13cf6f4ae7515768bb9e6305e1a7e4dacd20e4dc6ff` |
| `types.ts` | `a54fd8d97468bedd16cc1aae6d89648581da90bd55f65bb0b116c947893b5920` |
| `wasm.ts` | `0785024745568c86611b00a82f2bc8f70fc1559eff7200e64a449ebbeeeebb94` |
| `identifier.ts` | `c920a297e79186edc61348906950b639e8d67602122f165fb98012fd32be2f11` |

Only these seven files are vendored: the closure of `runtime/host.ts` (the sandbox host). `index.ts`, `source.ts` and `declarations.ts` are not used.

## Local changes

Every change sits between `// senpi-change begin: <topic>` and `// senpi-change end` lines, so a sync re-applies them block by block. Each one is an option whose default is upstream's behaviour: with the defaults, the ported upstream suite (`test/sandbox/vendor/upstream-sandbox.test.ts`, 47 cases, only its imports changed) passes unchanged.

1. **Output streaming** (`output: "stream"`, `onOutputFrame`, `windowBytes`, `frameBytes`; `types.ts`, `runtime/protocol.ts`, `runtime/worker.ts`, `runtime/host.ts`, `runtime/prelude-source.ts`). Upstream keeps every output item until the script settles, which is why it caps output at 16 Mi characters. In stream mode:
   - The host keeps nothing; `result.output` stays empty and `result.streamed` reports frames and the peak bytes in flight.
   - The worker splits each item into frames of at most `frameBytes` (default 64 KiB), never splitting a surrogate pair, tagged with item id, sequence and a final flag.
   - It sends a frame only after taking that many bytes from a shared credit counter (default window 256 KiB). It sleeps on the counter with `Atomics.wait` while the window is full, and re-checks the interrupt flag each time it wakes.
   - The host hands frames to the consumer one at a time, in order, and returns their credit only once the consumer has finished. The output cap does not apply, because memory is bounded by the window.
   - A normal finish settles only after every frame is consumed. An abort or timeout settles at once and drops frames still queued, so a stuck consumer cannot keep a run alive.
2. **Builtin store policy** (`builtins: { store: "collect" | "reject" }`; `types.ts`, `runtime/protocol.ts`, `runtime/worker.ts`, `runtime/host.ts`, `runtime/prelude-source.ts`). With `"reject"`, `load()` returns `undefined` and `store()` throws `CodemodeStoreDisabledError`. The names stay defined, so scripts written for upstream fail with a clear message instead of a ReferenceError.
