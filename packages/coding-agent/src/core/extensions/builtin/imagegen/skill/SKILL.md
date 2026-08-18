---
name: gpt-image-gen
description: MUST read before generating images. Detailed prompt-crafting guide for gpt-image models, covering tool routing (native image_generation server tool vs the generate_image tool), prompt structure from subject to background, verbatim text rendering, anti-patterns, and the revised_prompt feedback loop for iteration.
---

# GPT Image Generation

How to write image prompts that come back right the first time, and how to fix them fast when they don't. Read this before your first generation call.

## Which tool

When image generation tooling is present in your tool set, pick the surface that actually exists right now:

- If a native `image_generation` server tool is available, use it. The provider runs generation server-side and returns the image in the response stream.
- Otherwise, call the `generate_image` tool. It sends your prompt to the configured OpenAI-compatible endpoint and saves the result to a file.

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

## Editing and masks

v1 has no editing surface. The `generate_image` tool is text-only: it accepts a prompt and returns new images. There is no image input, no mask, no inpainting, no variation mode. The native `image_generation` server tool may perform provider-side edits on its own (action=auto), but no edit controls are exposed here.

Don't build workflows around editing. If the user asks to change an existing image, say that v1 generates from text only, then offer the closest text-only path: describe the desired end state as a full new prompt. Editing, masks, and image input are planned for a future version.

## Iteration workflow

- Generate one image first. Inspect the result against every clause of your prompt before spending more.
- Correct deviations by editing the prompt, not by hoping. Name what was wrong and what stays fixed.
- Batch with `n` only after the prompt is proven. `n` variants of a bad prompt is `n` bad images.
- Keep the full prompt text in the conversation. It is your reproducibility record: anyone can re-run the exact call later, and you can diff prompt versions when results drift.
