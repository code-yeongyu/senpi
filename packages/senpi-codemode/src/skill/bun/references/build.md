# bun build / Bun.build() in 1.4.x

## Compiled-binary rules learned in production (omo ships one)

- **`bun` inside a compiled binary can be the binary itself.** Bun Shell resolves `bun` to `process.execPath` when PATH has no bun; in a `--compile` app that re-runs the app's own entry (argv `["bun", "/$bunfs/root/..."]`), which booted a phantom agent turn (omo#9362). `BUN_BE_BUN=1` makes a compiled executable behave as plain bun, but it propagates to grandchildren; senpi appends a real bun shim to PATH instead. `Bun.spawn(["bun"])` does not fall back (ENOENT).
- Worker threads do not see main-thread `process.env` writes — env for a kernel worker must travel explicitly.
- `bun:ffi` `cc()` cannot compile a `.c` file embedded in `$bunfs`; avoid runtime C compilation in shipped binaries (2026-10-26).
- `--compile` binaries ignore `NODE_COMPILE_CACHE` [v1.4.1] and no longer auto-load `tsconfig.json`/`package.json` from the cwd (`--compile-autoload-tsconfig` / `--compile-autoload-package-json` opt back in); `.env` and `bunfig.toml` still auto-load.
- `--compile-exec-argv="--disallow-code-generation-from-strings=strict"` bakes runtime flags into the binary; `BUN_OPTIONS` at launch can raise but not lower them.

## Built-in React Compiler [v1.4.0]

Blog: [#built-in-react-compiler](https://bun.com/blog/bun-v1.4#built-in-react-compiler)

```ts
await Bun.build({ entrypoints: ["./src/index.tsx"], outdir: "./dist", reactCompiler: true });
// or: bun build --react-compiler
```

React's auto-memoization compiler runs inside Bun's parser — no Babel/SWC round-trip. On ~860 components: +71ms build cost, ~20x faster than the Babel plugin (9.15s); full `--compile` build 3.6x faster.

## Barrel import optimization [v1.3.10]

Blog: [#barrel-import-optimization](https://bun.com/blog/bun-v1.4#barrel-import-optimization)

```ts
await Bun.build({ entrypoints: ["./src/index.tsx"], optimizeImports: ["antd", "@mui/material"] });
```

`import { Button } from "antd"` skips the hundreds of files behind names you didn't import. Automatic for packages with `"sideEffects": false`; opt others in with `optimizeImports`.

## Smaller output since 1.4.1

- `export * as` groups (zod, Effect, fp-ts) tree-shake to the members you call: zod 4.5 375 KB → 77 KB minified. Namespace objects still accept assignment; `--no-deprecated-namespace-object-setters` makes them getter-only (future default).
- Dynamic `import()` and `require()` of an ES module tree-shake unused exports when every use reads a named export (`const { z } = await import("zod")` bundles like a static import).
- `--splitting`: fewer chunks (shared code stays in the entry), `--min-chunk-size=16384` folds tiny side-effect-free chunks, `<link rel="modulepreload">` + `__preload()` are emitted for browser builds (`--no-module-preload` to disable), bundle-wide names shrink minified output ~19%.
- `--splitting --target bun`: `require()` of an ES module becomes a lazy chunk (startup 23 ms → 11 ms on a 400-module CLI); `--no-split-require` keeps the old inlining.
- `[hash9]`…`[hash13]` in `naming` widens chunk hashes; two chunks can no longer collide on an 8-char hash [v1.4.3]. `metafile.inputs[*].entryPoint` names the file behind a split `import()` [v1.4.3].
- `Bun.build({ check: true })` / `bun build --check` type-checks first and writes nothing on a type error [v1.4.3].

## Compile-time feature flags: bun:bundle [v1.3.5]

Blog: [#compile-time-feature-flags-with-bun-bundle](https://bun.com/blog/bun-v1.4#compile-time-feature-flags-with-bun-bundle)

```ts
import { feature } from "bun:bundle";
if (feature("SUPER_SECRET")) { console.log("enabled"); }
// bun build --feature=SUPER_SECRET index.ts   (also works in bun run and bun test)
// Bun.build({ features: ["SUPER_SECRET"] })
```

Becomes `true`/`false` at build time; dead branch removed.

## In-memory files [v1.3.6]

Blog: [#in-memory-files-in-bun-build](https://bun.com/blog/bun-v1.4#in-memory-files-in-bun-build)

```ts
await Bun.build({
  entrypoints: ["/app/index.ts"],
  files: {
    "/app/index.ts": `import { greet } from "./greet.ts"; console.log(greet("World"));`,
    "/app/greet.ts": `export function greet(n: string) { return "Hello, " + n; }`,
  },
});
```

Strings, Blobs, or TypedArrays; virtual paths override disk. Ideal for codegen and stubbing modules in tests.

## Single-file HTML [v1.3.10]

Blog: [#single-file-html-with-compile-target-browser](https://bun.com/blog/bun-v1.4#single-file-html-with-compile-target-browser)

```bash
bun build ./index.html --compile --target=browser --outdir=dist
# → dist/index.html — every script/stylesheet/asset inlined, opens from file://
```

## --asset: embed files/dirs into executables [v1.4.0]

Blog: [#asset](https://bun.com/blog/bun-v1.4#asset)

```bash
bun build ./build/index.js --compile \
    --asset ./build/client --asset ./build/prerendered \
    --outfile server
./server   # every route + static asset served from the binary
```

Keeps original filenames; `path.join(import.meta.dir, ...)` works. `node:fs` treats `/$bunfs/` as a real tree (`existsSync`, `readdirSync` recursive/withFileTypes, ...), so static-file servers run unmodified inside the binary.

## Bytecode for ES modules [v1.3.9], smaller and PGO-ordered [v1.4.1, v1.4.3]

Blog: [#bytecode-compilation-for-es-modules](https://bun.com/blog/bun-v1.4#bytecode-compilation-for-es-modules), [1.4.3 #profile-guided-bytecode-layout](https://bun.com/blog/bun-v1.4.3)

`--bytecode --format=esm` (requires `--compile`) enables top-level await, `import.meta`, dynamic imports, and code splitting in bytecode-compiled binaries (previously CJS-only). Bytecode is now ~3x the source size instead of 9x (Claude Code's install: 376 MB → 207 MB) and the cache format is identical on every platform, so cross-compiling with `--bytecode` works and builds are byte-identical [v1.4.1].

```bash
bun build --compile --bytecode ./cli.ts --outfile myapp
BUN_BYTECODE_ORDER_OUT=myapp.order ./myapp --help        # run it the way users do; the profile is written on exit
bun build --compile --bytecode --bytecode-order=myapp.order ./cli.ts --outfile myapp   # cold start 1.01 s → 0.53 s on a large CLI
```

- `--bytecode-depth=1` limits ahead-of-time bytecode to shallow functions (rest compile on first call); `--compile-jit-policy <n>` keeps run-once startup code in the interpreter, then `Bun.unsafe.setJITPolicy(1)` once interactive; `--no-optimize-bytecode` skips the optimizer. `bytecodeOrderStats()` from `bun:jsc` reports profile coverage.
- Text imports (`with { type: "text" }`) are embedded once, pre-encoded: a 3 MB file adds 3 MB to the binary and ~1 MB of memory instead of 6 MB / 12.6 MB [v1.4.1].

## metafile: true and --metafile-md [v1.3.6 / v1.3.8]

Blog: [#metafile-true](https://bun.com/blog/bun-v1.4#metafile-true), [#metafile-md](https://bun.com/blog/bun-v1.4#metafile-md)

```ts
const result = await Bun.build({ entrypoints: ["./index.js"], metafile: true });
result.metafile.inputs; result.metafile.outputs; // esbuild metafile format — works with esbuild.github.io/analyze
```

```bash
bun build entry.js --metafile-md=analysis.md --outdir=dist   # Markdown bundle report: largest modules,
                                                             # per-entry breakdowns, dependency chains — grep it or hand to an LLM
```

## Standard TC39 decorators [v1.3.10]

Blog: [#standard-tc39-decorators](https://bun.com/blog/bun-v1.4#standard-tc39-decorators)

```ts
function logged(value, { kind, name }) {
  if (kind === "method") return function (...args) { console.log(`calling ${name}`); return value.call(this, ...args); };
}
class C { @logged greet() {} }
```

Active when `experimentalDecorators` is off in tsconfig. Classes, methods, fields, accessors, private members; passes esbuild's decorator test suite.

## Code splitting: 14x faster on huge graphs [v1.4.0]

Reachability walk is now BFS O(V+E); a 20,000-module DAG links in 320ms (was 4.65s). Tree-shaking/TLA/CSS-order passes use explicit stacks, so linear chains of thousands of modules link without stack growth.

## Memory and speed [v1.4.1, v1.4.3]

Bundling three.js x100: 1.83 s → 1.12 s. 800 entry points with `--splitting`: peak RSS 2,121 MB → 276 MB [v1.4.3]. Nested classes and functions keep their names (`Model`, not `Model2`) [v1.4.1].
