# builtin/webfetch

## OVERVIEW
URL-retrieval domain (score 8): bounded network reads and lazy HTML conversion feed the `webfetch` tool.

## WHERE TO LOOK

| Task | File |
|---|---|
| Enablement and tool registration | `index.ts` |
| Tool arguments, progress, output cap | `webfetch/tool.ts` |
| HTTP request, redirect, timeout, body limits | `webfetch/fetcher.ts` |
| Response draining/destruction | `webfetch/response-body.ts` |
| Conversion facade | `webfetch/content.ts` |
| Heavy HTML conversion dependencies | `webfetch/content.lazy.ts` |
| Typed fetch failures | `webfetch/errors.ts` |
| Call/result display | `webfetch/renderers.ts` |

## CONVENTIONS

- `PI_WEBFETCH` is default-on; explicit `0`, `false`, `no`, or `off` disables registration entirely.
- Unknown enablement values retain the default-on behavior.
- Formats are `markdown`, `text`, and `html`; network handling and conversion remain separate stages.
- Network response budget is 5 MiB; converted tool output has its own 50 KiB cap.
- Timeout defaults to 30 seconds and clamps to 120; redirect traversal caps at 20.
- Caller cancellation and timeout share the request abort path, with timer/listener cleanup.
- `jsdom`, Readability, and Turndown remain behind the existing lazy conversion boundary.
- Response disposal destroys the body even if discard fails; this cleanup exception is intentionally narrow.

## ANTI-PATTERNS

- Eagerly importing the HTML conversion stack into startup registration.
- Treating the output cap as a substitute for bounding downloaded bytes.
- Following redirects without preserving abort, timeout, and response-body cleanup.
- Expanding the documented discard-error exception into silent failure of fetch or conversion.
