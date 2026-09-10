# builtin/look-at

## OVERVIEW
Vision-delegation domain (score 8): `look_at` lets a non-vision active model query an available vision-model chain.

## WHERE TO LOOK

| Task | File |
|---|---|
| Tool activation on session/model changes | `index.ts` |
| Normalize compatibility argument forms | `arguments.ts` |
| Read attachments, paths, and base64 | `image-input.ts` |
| Pick an available vision model | `model-selector.ts` |
| Execute the delegated request | `runner.ts` |
| Session override and configured chain | `settings.ts` |
| `/lookat` command | `commands.ts` |
| Call/result display and details | `render.ts` |
| Description and delegated prompt | `prompts.ts` |

## CONVENTIONS

- Activation requires enablement, an active model without image input, and an available vision candidate.
- Keep registration distinct from activation; model switches resynchronize the active tool list.
- External parameters are snake_case; singular inputs and legacy `path` normalize into plural forms.
- Image loading accepts local paths, attachment references, and base64, not remote URLs.
- Input limits are 10 MiB per image and 25 MiB aggregate, with configured resize/block behavior.
- Chain selectors support provider/model patterns and thinking-level suffixes.
- The runner owns auth, timeout, and abort handling; render details preserve model, source, and MIME metadata.
- The model-facing result is the delegated response body, not a synthetic transcript of the request.

## ANTI-PATTERNS

- Leaving `look_at` active after switching to an image-capable primary model.
- Giving remote URLs filesystem semantics or bypassing aggregate image limits.
- Duplicating legacy-input normalization in the executor or command handler.
- Replacing unavailable-model feedback with fabricated visual detail.
