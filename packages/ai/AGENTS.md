# ai

Unified multi-provider LLM API. Supports streaming, tool calling, thinking, images, prompt caching across 10+ providers.

## FORK STRATEGY (THIS PACKAGE)

Adding new providers is safe (additive, low conflict). Modifying existing providers or core types has high conflict risk. New providers can also be added via extensions (`pi.registerProvider()`).

## STRUCTURE

```
src/
├── types.ts                     # Core types: Api, StreamOptions, Message, Model, KnownProvider
├── stream.ts                    # Streaming utilities
├── models.ts / models.generated.ts  # Model definitions (auto-generated)
├── api-registry.ts              # registerApiProvider(), lazy loading
├── env-api-keys.ts              # Credential detection (MUST use inline imports)
├── oauth.ts                     # OAuth token management
├── providers/
│   ├── register-builtins.ts     # Lazy loader wrappers (never static import providers here)
│   ├── transform-messages.ts    # Cross-provider message conversion
│   ├── simple-options.ts        # SimpleStreamOptions mapping
│   ├── faux.ts                  # Mock provider for testing
│   ├── anthropic.ts             # Anthropic Claude
│   ├── openai-responses.ts      # OpenAI Responses API
│   ├── openai-completions.ts    # OpenAI Completions API
│   ├── google.ts                # Google Gemini
│   ├── google-vertex.ts         # Google Vertex AI
│   ├── mistral.ts               # Mistral
│   ├── amazon-bedrock.ts        # AWS Bedrock
│   ├── azure-openai-responses.ts # Azure OpenAI
│   └── (more providers)
└── utils/oauth/                 # Per-provider OAuth implementations

test/
├── stream.test.ts               # E2E tests for all providers (1400+ lines)
├── faux-provider.test.ts        # Faux provider self-tests
├── cross-provider-handoff.test.ts
├── data/red-circle.png          # Image test fixture
└── (tokens, abort, empty, context-overflow, image, unicode tests)
```

## WHERE TO LOOK

| Task | File(s) | Notes |
|------|---------|-------|
| Add provider | See root AGENTS.md 7-step checklist | All 7 steps required |
| Add model | `scripts/generate-models.ts` | Auto-generates `models.generated.ts` |
| Provider registration | `src/api-registry.ts` | `registerApiProvider()` + lazy wrappers |
| Credential detection | `src/env-api-keys.ts` | MUST use inline imports (browser compat) |
| Message format conversion | `src/providers/transform-messages.ts` | Cross-provider message mapping |
| Mock/test provider | `src/providers/faux.ts` | `registerFauxProvider()`, `fauxAssistantMessage()` |

## CONVENTIONS

- **Lazy loading**: Providers loaded on-demand via promise wrappers in `register-builtins.ts`. Never static import provider modules there.
- **Subpath exports**: Each provider has its own export path in `package.json` (e.g., `./anthropic`)
- **Browser compatibility**: `env-api-keys.ts` and OAuth files MUST use inline imports. Comment: "NEVER convert to top-level imports - breaks browser/Vite builds"
- **Stream function pattern**: Each provider exports `stream<Provider>()` returning `AssistantMessageEventStream`
- **Test pattern**: `describe.skipIf(!process.env.API_KEY)` for E2E tests. `{ retry: 3 }` for flaky APIs.

## ANTI-PATTERNS

- Static imports in `register-builtins.ts` (breaks lazy loading)
- Top-level imports in `env-api-keys.ts` or OAuth files (breaks browser builds)
- Using real API keys in unit tests (use faux provider)
- Guessing external API types (check `node_modules` definitions)
