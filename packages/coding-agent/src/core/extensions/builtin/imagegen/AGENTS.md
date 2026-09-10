# builtin/imagegen

## OVERVIEW
Client image-generation domain (score 8), sharing auth and bypass state with the sibling native OpenAI image lane.

## WHERE TO LOOK

| Task | File |
|---|---|
| Register the tool and bundled skill | `index.ts` |
| Generate and save images | `tool.ts` |
| Resolve credentials | `auth.ts` |
| Validate tool parameters | `params.ts` |
| Choose safe output filenames | `paths.ts` |
| Load reference images | `reference-images.ts` |
| Registry override/native bypass | `state.ts` |
| Model-facing image workflow | `skill/SKILL.md` |

## CONVENTIONS

- Tool registration is separate from credential-gated skill discovery and prompt augmentation.
- `registerImageGenExtension` accepts a base directory so copied and embedded assets can be exercised independently.
- Node distribution uses the copied skill; Bun compilation can resolve an embedded file asset.
- Auth is resolved through the model registry: stored OpenAI, a pinned gateway, sorted gateways, then environment fallback.
- Shared native-generation integration belongs in `state.ts`; the native lane can bypass client-side execution.
- Default outputs go under `generated-images/`; generated names sanitize and bound the tool-call identifier.
- Output creation uses exclusive writes; partial multi-image saves are rolled back if a later save fails.
- Reference-image inputs have a separate 50 MiB per-file boundary, not look-at's limits.

## ANTI-PATTERNS

- Reading `models.json` or `auth.json` directly instead of using registry auth resolution.
- Logging or returning key material, or accepting placeholder sentinel keys as credentials.
- Overwriting an existing image path to make a generation call succeed.
- Removing the compiled-binary skill fallback because the source-tree skill exists locally.
