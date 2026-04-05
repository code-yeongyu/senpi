# Local fork changes

## 2026-04-05 — add `sanepi` CLI alias

- Changed: `packages/coding-agent/package.json`
- Why: The user wants the built CLI to be directly runnable via `sanepi`. This cannot be implemented through the extension system because shell command exposure is controlled by the package `bin` map, not runtime extension hooks.
- What changed: Added a second CLI bin alias, `sanepi`, pointing at the existing `dist/cli.js` entrypoint alongside `pi`.
- Merge-conflict risk: low. The only expected conflict zone is the `bin` field in `packages/coding-agent/package.json` if upstream changes CLI entrypoint names or packaging layout.
