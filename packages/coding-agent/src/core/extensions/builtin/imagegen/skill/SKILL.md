---
name: gpt-image-gen
description: MUST read before generating images. Prompt-crafting guide for gpt-image-2.5 covering tool routing (native image_generation server tool vs the generate_image tool), model and quality selection, prompt structure, exact text rendering, reference-image editing, transparent assets, output formats, and multi-turn refinement.
---

# GPT Image Generation

How to get the image right the first time, and how to fix it fast when it is not. Read this before your first generation call.

## Which tool

When image generation tooling is present in your tool set, pick the surface that actually exists right now:

- If a native `image_generation` server tool is available, use it. The provider runs generation server-side and returns the image in the response stream.
- Otherwise, call the `generate_image` tool. It sends your prompt and optional reference images to the configured OpenAI-compatible endpoint and saves the result as a png, jpeg, or webp file. The model, quality, size, background, and format controls below apply to `generate_image`, not to the native server tool.

Check your current tool set before choosing. Tool state can change mid-session (model switch, credential change), so trust the tools you can see over what this page said at startup. If both surfaces ever appear, prefer the native server tool. When the request is clear, generate directly instead of asking for confirmation; ask only when a required reference image is missing.

## Model selection

- `gpt-image-2.5-sunburst` (default): the base model, optimized for quality, above gpt-image-2. Use it for precise edits, fidelity to reference subjects and products, dense text or diagrams, and final production assets.
- `gpt-image-2.5-flare`: the small model, optimized for speed, with quality comparable to gpt-image-2. Reach for it when latency or volume matters more than the last increment of quality.
- `gpt-image-2`: previous generation; quality tiers stop at `high`, transparency is preview-level.

The default is the better model on purpose. When a workflow turns out to be latency-sensitive, run the same prompt and inputs on Flare and switch only if the result still meets the bar.

## Prompt crafting

Start from the deliverable, then describe what is visible. Match the prompt's specificity to the user's request:

- A specific request (exact text, a named layout, a product photo brief) is normalized, not padded. Keep every stated requirement; do not add objects, people, brands, slogans, or story beats the user did not ask for.
- A generic request ("a logo for a bakery") gets tasteful concreteness: medium, composition, lighting, palette, materials. Stay within what the request implies.

Cover these when they matter: the deliverable and its use (poster, product shot, UI mockup, diagram, icon); the subject with concrete physical detail; one medium or style, stated plainly; composition and camera (framing, angle, focal length or its visual equivalent); lighting and color; mood; background and how much of it is in focus. For people, describe body framing, gaze, and interaction ("full body visible, feet included", "looking down at the open book").

A short specific prompt is fine. For complex requests, organize the prompt into labeled sections (scene, subject, details, constraints); a descriptive paragraph and a labeled spec express the same intent, so choose whichever is easier to read and update. Request "photorealistic" or "real photograph" explicitly when that is the goal; camera specifications are cues for appearance, not a guarantee of exact optics.

### Rendering text in the image

Put the exact string in double quotes, say how many times it appears, and describe its position and typography: `A weathered wooden sign above the door reads "OPEN TIL LATE" once, in hand-painted white serif letters, centered, slightly faded.` Spell unusual words or brand names letter by letter when they matter. Add "no other text" so the model does not invent captions. Keep on-image text short; long passages smear. Use `quality` `medium` or `high` for small text, dense labels, or multiple fonts, then check spelling and legibility in the result.

### Anti-patterns

- Contradictory instructions. "Photorealistic watercolor" or "minimalist scene packed with detail" averages two opposing goals, and you get neither.
- Element overcrowding. Past roughly five or six distinct elements, small ones get dropped or mangled. Cut before you add.
- Style-list collisions. "In the style of anime, oil painting, and pixel art" is three prompts. Choose one style per image and generate variants separately.
- Invented content. Extra characters, logos, watermarks, or slogans the user never asked for. State exclusions when the model tends to add them ("no watermark, no logo").

## Quality, size, and format

`quality` accepts `low`, `medium`, `high`, `xhigh`, `max`, or `auto` (default). Explore with `auto` or a lower tier; raise it for the final image only while it fixes an unmet requirement, since a higher tier does not guarantee a better image and costs more latency. `xhigh` and `max` exist only on GPT Image 2.5; the API rejects them on `gpt-image-2`.

`size` defaults to `auto`. Presets: `1024x1024`, `1536x1024` (landscape), `1024x1536` (portrait). Custom `WIDTHxHEIGHT` works when both edges are multiples of 16, the aspect ratio stays within 1:3 to 3:1, neither edge exceeds 3840, and the total pixel count is between 655,360 and 8,294,400 (4K is `3840x2160` or `2160x3840`, not `3840x3840`). Outputs above `2560x1440` are experimental; square images are usually fastest.

`output_format`: `png` (default) is lossless and keeps alpha; `jpeg` is the fastest and smallest for photos with no transparency; `webp` is small and keeps alpha. `output_compression` (0-100) applies to jpeg and webp only. The `output_path` extension must match the format or be omitted.

### Transparent assets

For logos, stickers, cutouts, and UI icons set `background: "transparent"` with `output_format` `png` or `webp`, and also ask for an isolated subject in the prompt ("isolated on a transparent background, no drop shadow"). A drawn checkerboard is not transparency: after saving, confirm the file has an alpha channel (the result reports `Background: transparent` when the provider confirms it) and inspect edges, hair, glass, and shadows. Repeat the transparent requirement on every later edit of that asset. On `gpt-image-2` transparency is a preview feature; prefer a 2.5 model and verify the alpha channel either way.

## Editing with reference images

Pass `reference_image_paths` to edit an existing image or to use images as references: 1-5 local png, jpeg, or webp files, each at most 50 MB, absolute or relative to the working directory. With references the tool sends an image-edit request; without them it generates from text. Assign each input a role by position ("image 1 is the product to keep unchanged; image 2 is the style reference") and say how they combine.

Separate the change from the constraints. Say "change only X" and list what must stay fixed: identity, geometry, layout, lighting, labels, colors, surrounding objects. Describe the desired END STATE, not only the delta.

For a local repaint, add `mask_image_path`: a png with an alpha channel the same size as the first reference, where transparent pixels mark the area to repaint. Masking is prompt-guided, so restate the edit and the preserved regions in words too.

```json
{
  "prompt": "The same red fox from image 1, now wearing a knitted blue scarf, in an eye-level wildlife photograph. Change only the scarf. Preserve its face, fur markings, pose, and forest background; soft overcast light, muted woodland colors, shallow depth of field.",
  "model": "gpt-image-2.5-sunburst",
  "reference_image_paths": ["art/fox.png"],
  "quality": "high",
  "size": "2048x1152",
  "output_path": "art/fox-with-scarf.png"
}
```

Use a new `output_path` so the source stays intact. Only the native server tool returns a `revised_prompt` (the mainline model's rewrite); the client tool reports one in `details.revisedPrompts` only when the provider sends it, so judge the saved image against your request rather than waiting for a rewrite.

## Multi-turn refinement

- Generate one image first and inspect it against every clause of the request before spending more.
- Refine one thing per turn: pass the previous output as the next `reference_image_paths` entry, request the single change, and restate the constraints that must survive. "Same style as before" carries context, but restate critical details if the result drifts.
- For a recurring character or product, establish one reference image and reuse it in every scene, repeating its defining details.
- `n` produces variants of one prompt; distinct assets need distinct calls. Use `n` only after the prompt is proven.
- Keep the full prompt text in the conversation as the reproducibility record.

## Check the result

Before handing the image over: required text is spelled correctly and legible; identities, product shapes, and labels survived; the edit changed only what was requested; a transparent asset has real alpha rather than a painted background; diagram labels and relationships are correct. Fix a miss by editing the prompt or masking the region, not by regenerating blindly.
