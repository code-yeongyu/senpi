# Environment variables

## Isolation (set by the QA harness — do not set these yourself for real use)

| Var | Purpose |
|---|---|
| `SENPI_CODING_AGENT_DIR` | Agent config dir (auth.json, models.json, settings, sessions). QA points it at a temp sandbox so the real `~/.senpi/agent` is untouched. |
| `SENPI_CODING_AGENT_SESSION_DIR` | Session storage dir. QA points it at the sandbox. |
| `PI_OFFLINE` | `1` disables startup network operations. QA always sets it. |
| `PI_TELEMETRY` | `0` disables install telemetry. QA always sets it. |
| `PI_PACKAGE_DIR` | Override package asset dir (Nix/Guix). Not used by QA. |

Names derive from `piConfig.name` ("senpi") in
`packages/coding-agent/package.json`:
`ENV_AGENT_DIR = SENPI_CODING_AGENT_DIR`,
`ENV_SESSION_DIR = SENPI_CODING_AGENT_SESSION_DIR` (see
`packages/coding-agent/src/config.ts`). Real config dir: `~/.senpi/agent/`.

## Provider keys (source of truth: `packages/ai/src/env-api-keys.ts`)

The first present key wins; `devenv-setup.mjs` seeds `.env.local` from it.

`ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, `OPENAI_API_KEY`,
`AZURE_OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`,
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `FIREWORKS_API_KEY`,
`TOGETHER_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `ZAI_API_KEY`,
`MISTRAL_API_KEY`, `MINIMAX_API_KEY`, `MOONSHOT_API_KEY`, `KIMI_API_KEY`,
`OPENCODE_API_KEY`, `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID` /
`CLOUDFLARE_GATEWAY_ID`), `XIAOMI_API_KEY` (+ regional token-plan keys),
`ALIBABA_TOKEN_PLAN_API_KEY`,
`HF_TOKEN`, and the AWS Bedrock / Google Vertex variable sets.

When you add a provider, add its key here AND to the `.devcontainer`
`secrets` block AND keep `env-api-keys.ts` as the source of truth.

## Custom provider (mock loop)

A custom provider lives in `models.json` under `SENPI_CODING_AGENT_DIR`, not an
env var. See `references/mock-loop.md` for the shape (`baseUrl`, `apiKey`,
`api: "openai-completions"`, `models[]`).
