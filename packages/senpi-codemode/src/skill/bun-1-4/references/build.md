# bun build / Bun.build() in 1.4

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

## Bytecode for ES modules [v1.3.9]

Blog: [#bytecode-compilation-for-es-modules](https://bun.com/blog/bun-v1.4#bytecode-compilation-for-es-modules)

`--bytecode --format=esm` (requires `--compile`) enables top-level await, `import.meta`, dynamic imports, and code splitting in bytecode-compiled binaries (previously CJS-only).

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

## Compile gotcha (v1.3.4 change)

`bun build --compile` binaries no longer auto-load `tsconfig.json` / `package.json` from the runtime cwd. Opt back in with `--compile-autoload-tsconfig` / `--compile-autoload-package-json`. `.env` and `bunfig.toml` still auto-load.
