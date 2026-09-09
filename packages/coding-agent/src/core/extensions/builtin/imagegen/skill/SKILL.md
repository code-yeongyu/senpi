---
name: gpt-image-gen
description: MUST read before generating images. Detailed prompt-crafting guide for gpt-image models, covering tool routing (native image_generation server tool vs the generate_image tool), prompt structure from subject to background, verbatim text rendering, anti-patterns, and the revised_prompt feedback loop for iteration.
---

# GPT Image Generation

How to write image prompts that come back right the first time, and how to fix them fast when they don't. Read this before your first generation call.

## Which tool

When image generation tooling is present in your tool set, pick the surface that actually exists right now:

- If a native `image_generation` server tool is available, use it. The provider runs generation server-side and returns the image in the response stream.
- Otherwise, call the `generate_image` tool. It sends your prompt and optional reference images to the configured OpenAI-compatible endpoint and saves the result as PNG files. Its default model is `gpt-image-2.5-sunburst`; choose `gpt-image-2.5-flare` for speed or `gpt-image-2` for the previous generation. These model and parameter controls apply to `generate_image`, not the native server tool.

Check your current tool set before choosing. Skill visibility refreshes on reload, but tool state can change mid-session (model switch, credential change), so trust the tools you can see over what this page said at startup. If both surfaces ever appear, prefer the native server tool.

## Prompt crafting

This section is the core of the skill. gpt-image models reward detail, and the single most common failure mode is a one-line prompt.

Build each prompt from six parts, in this order:

1. Subject. Who or what, with concrete physical detail. "A middle-aged baker with flour on her forearms and a gray-streaked braid" beats "a baker".
2. Medium and style. One style, stated plainly: "35mm film photograph", "watercolor illustration", "flat vector poster". Pick one lane.
3. Composition and camera. Framing, angle, focal length or its visual equivalent. "Eye-level medium close-up, shallow depth of field, subject left of center".
4. Lighting and color. Direction, quality, palette. "Soft window light from the left, warm amber tones against deep shadow".
5. Mood. The emotional register: quiet, tense, celebratory, clinical.
6. Background. What sits behind the subject, and how much of it is in focus.

A good prompt reads as a short paragraph, not a list and not a lone sentence. If your prompt fits on one line, it is under-specified, and the model will fill the gaps with whatever it likes.

### Rendering text in the image

When the image must contain readable text (a sign, a label, a headline), put the exact string in double quotes and state the font style and placement:

A weathered wooden sign above the door reads "OPEN TIL LATE" in hand-painted white serif letters, centered, slightly faded.

Keep on-image text short. Long passages smear. If the layout matters, say where each string sits.

### Anti-patterns

- Contradictory instructions. "Photorealistic watercolor" or "minimalist scene packed with detail" forces the model to average two opposing goals, and you get neither.
- Element overcrowding. Every named object competes for pixels and attention. Past roughly five or six distinct elements, small ones get dropped or mangled. Cut before you add.
- Style-list collisions. "In the style of anime, oil painting, and pixel art" is three prompts in a trench coat. Choose one style per image and generate variants separately.

### The revised_prompt loop

Both surfaces can return a `revised_prompt`: the prompt the model actually used after its own rewrite. Always read it.

1. Diff it against your intent. Note what the model added, dropped, or reinterpreted.
2. Fold the delta into your next prompt explicitly. If the rewrite dropped "overcast sky", put "overcast sky, no direct sunlight" back with more weight. If it added something you dislike, name the exclusion ("no lens flare").
3. Regenerate. Treat each round as a conversation with the rewriter, not a fresh roll of the dice.

## Model selection

- `gpt-image-2.5-sunburst` (default): most capable; choose it for precise edits, difficult compositions, and fidelity to references.
- `gpt-image-2.5-flare`: fastest; choose it for everyday generation and quick iterations.
- `gpt-image-2`: legacy, previous-generation option.

## Quality tiers

`quality` accepts `low`, `medium`, `high`, `xhigh`, `max`, or `auto` (default). Start with `auto` or a lower tier while exploring, then increase quality for the final image. `xhigh` and `max` are available only on GPT Image 2.5 and incur higher latency and cost. Do not request them with `gpt-image-2`; the API rejects unsupported model/tier combinations.

## Image sizes

`size` defaults to `auto`. Choose a preset or an arbitrary `WIDTHxHEIGHT` for GPT Image 2 / 2.5. Custom dimensions must satisfy all of these constraints:

- Both width and height are divisible by 16.
- Aspect ratio is between 1:3 and 3:1, inclusive.
- Neither edge exceeds 3840 pixels.
- Total pixels are between 655,360 and 8,294,400, inclusive (the upper limit is 3840x2160 or 2160x3840, not 3840x3840).

| Size | Typical use |
| --- | --- |
| `auto` | Let the model choose |
| `1024x1024` | Square preset |
| `1536x1024` | Landscape preset |
| `1024x1536` | Portrait preset |
| `2048x2048` | Larger square |
| `2048x1152` | 16:9 landscape |
| `3840x2160` | Maximum-pixel 16:9 landscape |
| `2160x3840` | Maximum-pixel 9:16 portrait |

## Editing with reference images

Pass `reference_image_paths` to edit an existing image or use images as visual references. Supply 1-5 local PNG, JPEG, or WEBP files, each at most 50 MB. Paths may be absolute or relative to the current working directory. With references the tool sends an image-edit request; without them it generates from text.

Describe the desired END STATE in the prompt, not just a terse change instruction. State what must remain unchanged and what the finished image should contain. When passing multiple references, identify their roles in the same order as the paths.

```json
{
  "prompt": "The same red fox from the reference, now wearing a knitted blue scarf, in an eye-level wildlife photograph. Preserve its face, fur markings, pose, and forest background. Soft overcast light, muted woodland colors, shallow depth of field; only the scarf is new.",
  "model": "gpt-image-2.5-sunburst",
  "reference_image_paths": ["art/fox.png"],
  "quality": "high",
  "size": "2048x1152",
  "output_path": "art/fox-with-scarf.png"
}
```

Read any returned `revised_prompt` after an edit, just as after generation. The client tool includes these in its result text and `details.revisedPrompts`. Compare the rewrite and saved image against the desired end state before another edit, and use a new `output_path` to preserve the source image.

## Iteration workflow

- Generate one image first. Inspect the result against every clause of your prompt before spending more.
- Correct deviations by editing the prompt, not by hoping. Name what was wrong and what stays fixed.
- Batch with `n` only after the prompt is proven. `n` variants of a bad prompt is `n` bad images.
- Keep the full prompt text in the conversation. It is your reproducibility record: anyone can re-run the exact call later, and you can diff prompt versions when results drift.
