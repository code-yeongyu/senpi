# Credential injection (per harness)

senpi reads provider keys from the environment (see
`packages/ai/src/env-api-keys.ts`) and from `~/.senpi/agent/auth.json` (written
by `/login`). QA itself needs NO real key — Channel 3 uses a fake model. Real
keys are only for final real-provider smoke.

| Surface | What's needed | How it's injected |
|---|---|---|
| LLM call (real turn) | one provider key, e.g. `ANTHROPIC_API_KEY`, or `~/.senpi/agent/auth.json` | env var, `.env.local`, or `/login` |
| Private npm packages | none — senpi is public (`@earendil-works/*`, `@code-yeongyu/senpi`) | n/a |

## Single local store: `.env.local`

`scripts/devenv-setup.mjs` creates `.env.local` at the repo root (gitignored,
`chmod 600`), seeded from the first provider key found in the environment, else
an interactive prompt, else left as a template. It is the one place to keep a
local key.

## Per harness

- **Claude Code** — reads `.claude/skills/` (a symlink to `../.agents/skills`
  created by setup). Run `node scripts/devenv-setup.mjs` once; export the key in
  your shell or put it in `.env.local`.
- **Codex** — `.codex/setup.sh` runs on worktree create and execs
  `scripts/devenv-setup.sh`. Pass keys as env vars:
  `ANTHROPIC_API_KEY=sk-ant-... codex`.
- **opencode** — `opencode.json` points skills at `.agents/skills`. Key via env
  or `.env.local`.
- **Cursor** — `.cursor/settings.json` points skills at `.agents/skills`. Key in
  the integrated terminal env or `.env.local`.
- **VS Code Dev Containers** — `.devcontainer/devcontainer.json` `postCreate`
  runs setup; declare keys in the `secrets` block (prompted on container create).
- **GitHub Codespaces** — register the same keys under Settings → Codespaces →
  Secrets; the `secrets` block auto-injects them and `postCreate` seeds
  `.env.local`.

## Security

- Never commit `.env.local` (gitignored: `.env.local`, `.env.*.local`).
- Never write real keys into the QA sandbox or evidence. The sandbox uses a fake
  key (`sk-mock-qa-*`) for Channel 3.
- Mask keys in evidence/logs (`ANTHROPIC_API_KEY=***`).
- QA snapshots `~/.senpi/agent/auth.json` and asserts it is unchanged — QA must
  never mutate real credentials.
