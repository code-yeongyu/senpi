# extensions/llama

## OVERVIEW
Local llama.cpp management domain (score 8): a hidden built-in provider plus interactive `/llama` catalog, load, and download workflows.

## WHERE TO LOOK

| Task | File |
|---|---|
| Register provider and `/llama` | `index.ts` |
| Provider identity, auth, and model catalog | `provider.ts` |
| Router HTTP requests and progress | `client.ts` |
| Hugging Face search/token/model metadata | `huggingface.ts` |
| Dialogs, selectors, and cancellable progress | `ui.ts` |
| Hidden extension registration | `../index.ts` |

## CONVENTIONS

- This extension lives under `src/extensions/`, not the larger `core/extensions/builtin/` registry.
- Default server URL is `http://127.0.0.1:8080`; configured auth can supply `LLAMA_BASE_URL` or an auth base URL.
- `/llama` is interactive-only; other modes receive a notice rather than attempting a TUI dialog.
- A catalog refresh follows successful load/unload/download operations so provider availability stays current.
- Explicit `/llama` refresh permits network access even in `PI_OFFLINE` because the user already contacted the configured server.
- Both `loaded` and `sleeping` statuses count as loaded when choosing whether to replace existing models.
- Replace-and-load records the previous loaded set and attempts restoration on cancellation or failure.
- Progress operations distinguish cancellation from failure and refresh the catalog after returning to the model list.
- Hugging Face selections may include `repository:quantization`; gated models require server-side token access too.

## ANTI-PATTERNS

- Treating `hidden: true` as disabling registration; it hides the extension, not its provider functionality.
- Replacing models without the explicit keep/unload/cancel choice.
- Reporting a canceled download as a successful completed model load.
- Letting a restoration failure overwrite the original load failure diagnostic.
- Assuming the local UI's Hugging Face token automatically configures the remote llama.cpp server.
