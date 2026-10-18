# Measured read folders

Both built-in readers and ordinary session factories use the agent package's
`selectedReadFolder` through `createDefaultReadSummary`. Explicit offset/limit
requests, truncated input, prose and unselected languages retain the existing raw
read path. An explicitly supplied options object without a folder also stays raw.

The declaration-safe production bake-off selects default summaries for `.json` and,
since #1685, `.js`. Both engines are measured per language under one oracle and one
threshold rule. JavaScript takes the tree-sitter grammar engine on a 41.93% median
token saving against its 35.54% threshold, where the dependency-free scan reaches 0%.
JSON keeps the heuristic at 83.01% against 78.08%. TypeScript (0% vs 47.28%) and TSX
(0% vs 56.54%) stay raw with `wasm_candidate_below_threshold`: their measured grammar
candidate is safe and finds real bodies, but the minimum oracle skeleton of three of
five TypeScript files and all five TSX files exceeds the 100 visible-line budget, so
no engine can summarize them. Python, Rust and Go have no protected-interval source
oracle, so no grammar candidate is measured for them and they stay raw.
`READ_FOLDER_SELECTION` binds the superseding production measurement by commit and
SHA-256. The historical row-17 prototype and earlier JavaScript selection are not the
shipping selection.

The grammar engine lives in `tree-sitter/`. `prepareReadFolder` consults the frozen
selection first and loads a grammar lazily, on the first structural read for a
language bound to `wasm`; nothing else loads WebAssembly. Parsing runs inside a
250 ms budget, and an absent grammar, a tree with any error, or an exhausted budget
returns the heuristic folder's own result for that read. The vendored grammar and
runtime artifacts under `packages/agent/assets/tree-sitter` ship in the npm package
and are embedded in the compiled binary; `scripts/prepare-bun-compile-assets.mjs`
fails the build when one is missing or drifts from its recorded SHA-256.

The pure TS/JS candidates remain callable through `selectedReadFolder.fold` for
boundary tests and repeatable qualification measurements. This does not enable TS
summaries: default-read eligibility is separately and exclusively controlled by
`isReadSummaryPath`, including when a caller injects a custom folder. The bake-off
records the pure production candidate and actual selected default-read outputs
separately, and checks the latter against the frozen selection.

```ts
const parsed = selectedReadFolder.fold({ path, text, settings: READ_FOLD_SETTINGS });
const view = createSegmentedReadView({ text, parsed });
```

`ReadFolder` has immutable `id`/`version` and a synchronous pure `fold` method.
`parsed` binds exact input text to hierarchical inclusive 1-based omitted
interiors. A stale text/result pair or invalid hierarchy yields `no_summary`.
Unsupported extensions and prose are explicit outcomes; lexical ambiguity yields
`parse_failure`, never a partial list of plausible ranges. I/O and structured
cancellation stay outside this synchronous contract.

The lexer preserves quoted strings, templates/interpolation, comments, contextual
regexes and balanced delimiters. Binding/import/export members, class heritage,
decorators, parameter lists and return-type signatures stay protected through a
proven body boundary. Any candidate overlapping a protected interval is rejected,
including an enclosing class/function body. Unproved type-operator or angle syntax,
ambiguous comma binding, Unicode-set regex or unclosed literal falls back raw. This
is conservative lexical classification, not a partial TypeScript syntax validator.

The grammar engine derives the same protected intervals from the parse tree instead
of from a lexer: parameter lists, heritage clauses, decorators, import declarations,
binding patterns, computed member names, destructuring assignment targets, type
annotations and `as`/`satisfies` operands, plus every declaration line through the
line that opens its body. It emits only block, module, switch, object and array
interiors and non-documentation comments, and drops any candidate overlapping a
protected interval. Both engines are enumerated against the same 1440-program
adversarial grammar with zero counterexamples.

Bodies require four interior lines; ordinary comments require six total lines.
Safe sibling bodies preserve separate header and closing lines. The sole pure
segmented-view module validates source coverage and refines a FIFO frontier until
50 source lines are visible, never taking a step above 100. Oversized skeletons,
unreachable budgets, inputs below 100 lines and views without an output-byte
saving return `no_summary`. These policy constants are internal, not settings.

Kept text equals exact LF-split source slices, including CR bytes, whitespace and
terminal empty lines. Elisions contain coordinates only; rendering inserts an
ellipsis on its own line and supplies numeric `offset`/`limit` rereads. Synthetic
lines are not edit anchors. There are no merged brace lines, numbered fold IDs or
path-range selectors. Markdown variants and `.txt` remain prose-exempt.
