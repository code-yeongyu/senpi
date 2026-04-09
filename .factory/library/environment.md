# Environment

Environment variables, external dependencies, and platform notes for this mission.

**What belongs here:** Node version, external tool expectations, auth locations, quirks specific to sanepi-mono.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Runtime

- **Node.js:** >= 20.6.0 (required by `packages/coding-agent`).
- **Package manager:** npm workspaces.
- **TypeScript compiler:** `tsgo` (`@typescript/native-preview`), via `npm run build` / `npm run check`. The `coding-agent` package uses tsgo exclusively. Web-ui uses vanilla `tsc`, but it is not in this mission's scope.
- **Test runner:** Vitest, invoked via `npx tsx ../../node_modules/vitest/dist/cli.js --run` from package root.
- **Lint/format:** Biome 2.3.5, configured in `biome.json` at the repo root. Enforces 3-space indent (tabs in source) and 120-char lines.

## Auth

- Real LLM credentials are stored in `~/.pi/agent/auth.json`. Workers MUST NOT read or modify this file.
- All mission tests use the faux provider (`@mariozechner/pi-ai`'s `registerFauxProvider`). No real API calls.

## External tools expected on PATH

- `node` (required)
- `npm` (required)
- `git` (required)
- `rg` (ripgrep; strongly recommended — used for grep-check assertions)
- `tmux` (required for manual QA milestone features)
- `tsx` (installed as a dev dependency; invoked via `npx`)

## Settings files and their locations

- **Project settings:** `.pi/settings.json` at the repo root (or any cwd the CLI is run from).
- **Global settings:** `~/.pi/agent/settings.json`.
- The new `todotools.continuation.enabled` key lives under either file. See `.factory/library/architecture.md` for the resolution chain.

## pi-mono quirks

- **`.pi/` directory:** the repo uses `.pi/` (not `.pi-agent/` or `.sanepi/`) as the project config dir. Existing files there: `permissions-approved.jsonl`, `git/`, `npm/`, `prompts/`, `settings.json`.
- **Fork remotes:** `origin = code-yeongyu/sanepi-mono`, `upstream = badlogic/pi-mono`. Workers should only push to `origin` and must NEVER push to `upstream`.
- **Lockstep versioning:** All packages share the same version. This mission does not bump versions — that's a release-time concern.
- **`tsgo` is strict:** `any`, `@ts-ignore`, `@ts-expect-error` are forbidden. Narrow types explicitly via type guards instead.
- **Build side effect:** `npm run build` regenerates `packages/ai/src/models.generated.ts` via `packages/ai/scripts/generate-models.ts`, so coding-agent-only validation can still dirty that unrelated tracked file. Restore it before committing if your feature did not intentionally change AI model metadata.
