# packages/coding-agent/docs/

Public documentation for `@code-yeongyu/senpi`. Shipped inside the npm package: `package.json`
`files` array includes `"docs"`, so every file here lands in the published tarball.

## Navigation manifest

`docs.json` has two top-level keys: `navigation` (ordered section and page list) and `redirects`.
Page paths are relative to this directory.

- Every new `.md` file needs an entry in `docs.json` under `navigation`.
- Renamed or moved pages need a `redirects` entry to avoid broken links.
- Navigation-only stubs without real content belong in `redirects`, not `navigation`.

## Landing page and images

`index.md` is the landing page. Images live under `docs/images/`:
`doom-extension.png`, `exy.png`, `interactive-mode.png`, `tree-view.png`.

New images go in `docs/images/`. Don't reference images by absolute URL when a relative path works.

## Protocol and reference pages

These pages must track their implementation counterparts. Treat them as specs, not tutorials.

| Page | Tracks |
|------|--------|
| `rpc.md` | `packages/coding-agent/src/modes/rpc/` |
| `app-server.md` | `packages/coding-agent/src/modes/app-server/` |
| `json.md` | JSONL wire format and record shapes |
| `session-format.md` | Session file structure and field types |

Preserve LF line endings and exact field names in these pages. Field spellings and JSONL record
structures are asserted by tests; prose-only rewording can still break them.

## Validators

- `scripts/check-mcp-docs.test.mjs`: Parses `config-schema.ts` key names as raw text and
  checks that every field has a `### \`field\`` heading in `mcp.md`. Runs under
  `npm run test:scripts`. Schema additions without a matching doc heading break CI.

- `packages/coding-agent/test/qa/app-server/task20-doc-example-check.ts`: Spins up a live
  app-server process and validates that JSON examples in `app-server.md` match actual server
  behavior. Prose edits to `app-server.md` that change JSON shapes will fail this test.

## Terminology

Docs mix `senpi` and upstream `Pi` branding in legacy text. Don't do broad rebrand sweeps
during focused edits; update only the immediate context you're working in.

Consistent names: CLI binary is `senpi`, config directory is `.senpi`, npm package is
`@code-yeongyu/senpi`. Don't use `codex`, `pi`, or `openai-codex` in new prose.

## Security rules

- `bearerTokenEnv` names an environment variable, not a token value. Examples must never put
  a literal token in the JSON config; the implementation warns when it detects one.
- OAuth tokens persist under the agent directory at runtime. Don't surface them in doc examples
  or log snippets.
- MCP config values are not shell-expanded. Don't document or imply `$VAR` substitution in
  JSON config examples.
- `mcp.md` must not advertise URL-mode elicitation; it's not a shipped feature.

## Anti-patterns

- No new `.md` file without a `docs.json` entry.
- Don't edit protocol page prose without checking whether `task20-doc-example-check.ts` or
  `check-mcp-docs.test.mjs` would break.
- Don't copy claims from upstream Pi docs without verifying they apply to the senpi fork.
- Don't embed bearer tokens, session IDs, or raw API keys in example output.
