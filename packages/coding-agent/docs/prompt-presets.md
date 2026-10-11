# Shared Native prompt generation

The `@code-yeongyu/senpi/prompt-presets` subpath exposes the same prompt
generation functions used by the Native runtime. It does not launch a session,
load extensions, or keep a second set of model templates.

```ts
import {
  buildDynamicSystemPrompt,
  resolvePreset,
  type BuildDynamicSystemPromptOptions,
} from "@code-yeongyu/senpi/prompt-presets";

const options: BuildDynamicSystemPromptOptions = {
  cwd: "/project",
  selectedTools: ["read", "bash"],
  toolSnippets: {},
  promptGuidelines: [],
  contextFiles: [],
  skills: [],
  surface: "terminal",
  appName: "ExampleHost",
};
const model = { provider: "anthropic", id: "claude-opus-5-5" };
const resolved = resolvePreset(model, { promptPreset: "auto" }, options);
const modelCore = resolved?.prompt ?? buildDynamicSystemPrompt(options);
const hostRoleInstructions = "Review the supplied code without modifying files.";
const systemPrompt = `${modelCore}\n\n${hostRoleInstructions}`;
```

`hostRoleInstructions` is supplied by the host. Keep host tool adaptation and
role appends explicit and independently tested; do not copy or relabel model
bodies.

## Contract

- `resolvePreset(model, settings, options?)` returns `{ name, prompt }` or
  `undefined` when no preset applies. It preserves Native precedence: explicit
  settings, then model `promptPreset` metadata, then automatic model selection.
- `buildPreset(name, options)` renders an explicit preset, including manual-only
  presets such as `gpt-5`.
- `buildDynamicSystemPrompt(options)` renders the Native fallback.
- `appName` is optional. Omission retains the runtime's configured application
  name. An explicit value parameterizes generation without changing environment
  variables or global branding. Host adapters should always pass it explicitly,
  because omission follows the importing process's Native branding.
- Public options cover host identity, tools, context, skills, and reply surface.
  Internal core overrides, tuning sections, and workstation dialect hooks are
  not part of this public contract; append host role instructions after rendering.
- Model identity is the model's provider and full ID, including any namespace
  inside the ID. Pass the catalog display name and `promptPreset` metadata when
  available, just as Native does.
- The earlier `resolvePresetName`, `PROMPT_PRESET_MODEL_CASES`, and
  `AUTO_RESOLVED_PRESET_NAMES` exports remain available. The settings-free name
  resolver describes automatic selection; it does not apply explicit overrides
  or render content.

An explicit Native custom system prompt replaces the model core and bypasses
preset generation. To preserve model calibration, append host role instructions
to the generated core instead of passing the role as that custom override.
