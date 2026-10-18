# Read-summary bake-off (issue #1639)

These modules are test-only measurement adapters. They are not exported by the agent package or imported by production read tools. The integrated bake-off measures the production folder and sole segmented-view module; no WASM dependency is added.

## Experiment

- `corpus.ts` verifies the pinned repositories, frozen input manifest hash, deterministic path ordering, duplicate paths, source hashes, and size/line limits. The execution evidence's `prepare-corpus.py` inventories the pinned read-only checkouts and copies the first five eligible files per language into owned scratch. Inventory and exclusion reasons are retained in the manifest. Synthetic cases are separate.
- `reference.ts` executes the pinned omp **ReadTool** for a live experiment. Frozen replay authenticates those original captures, then verifies the installed `gpt-tokenizer@4.0.0` package and `o200k_base` file hashes before exact tokenization. Changed or additional tokenizer implementation bytes reject replay. The dependency never enters the senpi manifest.
- `oracle.ts` annotates source using the existing TypeScript compiler API, Python's AST, and Rust AST matches. TypeScript/JavaScript annotations whitelist implementation/value containers and exclude overlapping type, parameter, binding, decorator and heritage intervals and their descendants. It does not use candidate ranges or rendered omp output as truth. Rust shares its source parser with omp; this limitation is explicit in the evidence. Retained bytes and coordinates are checked separately.
- `production-candidate.ts` measures the shipping folder/view and checks the actual default reader against its selected language policy. Candidate qualification and shipped defaults are separate: losing TS and JS candidates remain measurable, but their real default reads stay raw. `raw-baseline.ts` uses the real reader with an explicitly supplied options object and no folder, so structural defaults cannot corrupt the denominator.
- The historical `heuristic.ts` prototype applies D4's visible-line budget to a dependency-free balanced-brace scanner and Python logical-line/indent scanner. The scanner handles escaped strings, nested template interpolation, contextual regex literals, Rust raw strings/characters/lifetimes/nested comments, and Python triple-quoted strings. Ambiguous regex, malformed tokens/indentation and JSX produce explicit per-file raw fallbacks. Declaration documentation is retained with signatures; ordinary block comments remain foldable at six lines. A correctness failure still disqualifies the language.
- `frozen-baseline.ts` verifies the original actual-ReadTool captures and historical annotation receipt. Corrected TypeScript/JavaScript/JSON source annotations are recomputed from the authenticated corpus; historical ranges cannot authorize a new candidate. Per-file discovered/emitted fold counts and the oracle's minimum possible skeleton size distinguish lexical failures from budget-driven fallbacks.
- `scorer.ts` applies the zero-invalid-boundary and 90%-of-reference median-saving rule. Positive total savings are mandatory. Missing reference/tokenizer makes evidence inconclusive. Insufficient corpus and unapproved WASM candidates remain per-language raw fallbacks.
- `omp-item1 --case compiled-parity` parses the compile commands used by `scripts/build-binaries.sh`, preserving publishing behavior without runtime package.json autoload. It builds that actual release entry graph with identical baseline/candidate flags for every shipped target. The required package/theme layout and version smoke are recorded explicitly.

## Running

Use a healthy approved remote runner with execution-owned senpi and omp copies. Install existing dependencies with `HUSKY=0 bun install --ignore-scripts --frozen-lockfile`. The omp copy also needs its version-matched native comparator addon. Never install reference/native dependencies into senpi or a read-only reference root.

Set `OMP_BAKEOFF_INPUT` to the copied corpus directory, `OMP_BAKEOFF_CORPUS_SHA256` to the frozen input manifest hash, and `OMP_BAKEOFF_REFERENCE` to the execution-owned omp copy. For a candidate-only rerun, also set `OMP_BAKEOFF_BASELINE` to the frozen output/annotation directory and `OMP_BAKEOFF_GATE` to the OQ1 receipt. That mode needs only the reference's pinned tokenizer, not its native addon: reference outputs are replayed byte-for-byte and source reads are checked against the frozen raw captures. Run from the senpi root:

```sh
bun --conditions=source scripts/qa/omp-item1.ts --case bakeoff --out "$E/selection.json"
bun --conditions=source scripts/qa/omp-item1.ts --case bakeoff-invalid --out "$E/failure.json"
```

The output directory contains corpus/source annotations, actual raw/omp outputs, production candidate/default-read outputs, source/output hash bindings, token counts, latency observations and per-language decisions. The default-read outputs follow the selected policy, while the candidate outputs measure the available production folder/view before enablement. Latencies have no pass/fail threshold. Registry-only grammar research is recorded separately in `grammar-pins.json`; it does not authorize acquisition or packaging.

Run the deterministic test target from `packages/agent`:

```sh
node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2 --config vitest.harness.config.ts test/harness/read-summary-bakeoff.test.ts
```

The report retains `OQ1_unresolved_defaults_used` by lead instruction and cites the later OQ1 receipt approving the eight-language evaluation with WASM disabled. Go has insufficient corpus and remains raw pending owner-approved additional sources. Markdown and plain text remain raw regardless of reference output. Production defaults consume the superseding measured selection rather than the old prototype percentages. Missing owner approval never authorizes WASM packaging.
