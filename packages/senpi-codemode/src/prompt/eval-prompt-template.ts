export const EVAL_PROMPT_TEMPLATE = `Run one step of code in a persistent kernel.

<instruction>
**One eval call = one cell = one logical step.** Top-level names persist per language across eval calls{{#if spawns}}, tool calls and \`task\` subagents{{else}} and tool calls{{/if}}: define helpers and clients once and reuse them instead of re-importing or re-reading. For large text, use bounded chunks or write it to a file and read it with offsets; treat truncation notices as incomplete data and follow the full-output path. Rebuild state only after \`reset\`, a kernel restart, or a \`NameError\`/\`ReferenceError\`, and check a sentinel variable first so a re-run cannot duplicate side effects.

{{#if styleClaude}}<eval_first_batching>
Batch a step's independent calls in one cell with \`parallel(thunks)\`; write real code around them - loops, branches, joins, a try/except per risky item - and keep every failed or missing item in the result verbatim; re-read truncated output before deciding.
{{#if monitor}}- Start long-running work (build, test run, deploy, or watch) through \`tool.monitor({ command, filter })\`, putting the decisive-line filter inside the same cell, then keep working until its event wakes the turn.{{/if}}
</eval_first_batching>{{/if}}{{#if styleGpt}}<gpt_eval_dialect>
GPT eval: batch a step's independent tool calls in one cell with \`tool.<name>(args)\` and \`parallel(thunks)\` and inspect every result.
{{#if monitor}}- A wait or a long run (build, test run, deploy, watch) starts through \`tool.monitor({ command, filter })\` in that same cell with the decisive-line filter; its event wakes the turn, so no cell sits on the wait and no child is spawned for it.
{{/if}}- Long cells detach on their own and notify on completion; do not poll or re-run them.
- Keep every failed or missing item in the result verbatim and re-read truncated output before deciding.
</gpt_eval_dialect>{{/if}}{{#if styleCodex}}Route a step's independent lookups through one eval cell via \`parallel(thunks)\` and inspect every result.
- Loop or comprehend over file sets with \`read()\`/stdlib instead of reading files one call at a time; post-process \`tool.<name>()\` results programmatically.
- Wrap failable calls in try/except inside the cell and keep every failed item in the result verbatim; after two distinct failed strategies for the same fact, fall back to direct tool calls.
- Re-read truncated output before deciding on it.
{{#if monitor}}- Long-running build/test/deploy/watch work: start \`tool.monitor({ command, filter })\` with the decisive-line filter inside the same cell, then continue working until its event wakes the turn.{{/if}}{{/if}}{{#if styleKimi}}Put a step's independent calls into one cell with \`parallel(thunks)\`.
- Write real code around the calls - loops, joins, a try/except per risky item - and keep every failed or missing item in the result verbatim; re-read truncated output before deciding.
{{#if monitor}}- Start long-running build, test run, deploy, or watch work with \`tool.monitor({ command, filter })\`, put the decisive-line filter inside the same cell, and keep working until its event wakes the turn.{{/if}}{{/if}}{{#if styleDefault}}Batch a step's independent calls in one cell with \`parallel(thunks)\`.
- Write real code around the calls - loops, branches, joins, a try/except per risky item - and keep every failed or missing item in the result verbatim; re-read truncated output before deciding.
{{#if monitor}}- Long-running build, test run, deploy, or watch work starts with \`tool.monitor({ command, filter })\`, with the decisive-line filter inside the same cell; keep working until its event wakes the turn.{{/if}}{{/if}}
{{#if hostLine}}
Host: {{hostLine}} — cells execute here. Size \`parallel(thunks)\` pools to its cores; \`tool.<name>()\` shell commands must fit this platform, even when the code you are writing targets another machine.
{{/if}}

\`language\`: {{#if py}}\`"py"\` IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}\`"js"\` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}, {{/ifAny}}\`"rb"\` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}, {{/ifAny}}\`"jl"\` persistent Julia kernel{{/if}}.

A cell that outlives the foreground window detaches: it keeps its language kernel busy (another language can continue) and completes as one notification with its value or error and buffered output. Its own execution time is capped at {{runBudgetSeconds}}s — time inside host tool calls is not charged; raise \`timeout\` only for a declared long run — and a killed js cell that cannot settle restarts its kernel with every global lost. Do not re-run a detached cell; read or cancel it with \`eval({ action: "peek", cell_id })\` / \`eval({ action: "stop", cell_id })\`.

{{#if py}}Python runs on a live event loop: use top-level \`await\`; \`asyncio.run(…)\` raises.{{/if}}
{{#if js}}{{#if jsBun}}JS runs in-process on Bun {{jsVersion}}: top-level \`await\`/\`return\` work; \`Bun.*\` builtins available, including \`new Bun.WebView()\` — a headless browser (navigate/click/evaluate/screenshot) to reach for before \`curl\` or a browser CLI when a page needs JS, a login, or a screenshot. Shell out through \`Bun.$\` or \`Bun.spawn\`, never \`Bun.spawnSync\`: a synchronous child blocks the worker and cannot be interrupted.{{#if bunSkillPath}} MUST READ the bun-1-4 skill at {{bunSkillPath}} before your first js cell — its builtins replace the npm packages you would otherwise install.{{/if}}{{else}}JS runs under Node.js worker: top-level \`await\`/\`return\` work; \`fetch\`/\`Buffer\` available.{{/if}}{{/if}}
{{#if rb}}Ruby: synchronous; helper options are keyword args{{#if spawns}} (e.g. \`output("id", limit: 2)\`){{/if}}; the last expression auto-displays unless it is \`nil\`, an assignment, or a definition (like IRB).{{/if}}
{{#if jl}}Julia: synchronous; helper options are standard keyword args{{#if spawns}} (e.g. \`output("id", limit=2)\`){{/if}}; the last expression auto-displays unless it is an assignment or a definition (like the Julia REPL).{{/if}}
On error, fix and re-run only the failing step; a normal error keeps state, while a timeout or stop message says whether the kernel restarted.
</instruction>

<prelude>
{{#ifAll py js}}Same helpers + arg order, both runtimes. Python: sync, options = trailing kwargs. JS: async/\`await\`able, options = ONE trailing object literal, never positional (extras throw).{{else}}{{#if py}}Sync; options = trailing kwargs.{{/if}}{{#if js}}Async/\`await\`able; options = ONE trailing object literal, never positional (extras throw).{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, options = trailing keyword args.{{/if}}{{#if jl}} Julia: sync, options = trailing keyword args.{{/if}}
\`\`\`
display(value) → None
    Cell output. Images reach you only through display: pass a figure, image bytes, a tool result, or its \`images[i]\`.
print(value, ...) → None
    Text output.
read(path, offset?=1, limit?=None) → str
    File as text; offset/limit are 1-indexed lines. Accepts \`local://…\`.
write(path, content) → str
    Write file (creates parents) → resolved path. \`local://…\` persists across turns/subagents.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value; two → set \`key=value\`.
{{#if spawns}}output(*ids, format?="raw", offset?=None, limit?=None) → str | dict | list[dict]
    Task/agent output by id. Reads immediately: running tasks return their status; \`format\` \`"raw"\` = full, \`"tail"\` = trailing.
{{/if}}tool.<name>(args) → { text, images?, details?, hasError? }
    Invoke any session tool; image results (e.g. \`tool.read\` on a png) arrive in \`images[i]\` as { mimeType, dataBase64 }.
tool_schema(name?) → dict
    Parameter schema of a tool (omit \`name\` to list tool names); a failed \`tool.<name>()\` call also returns the expected parameters.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless. \`model\`: \`"smol"\` fast | \`"default"\` session | \`"slow"\` most capable. \`schema\` (JSON-Schema) → parsed structured output.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, handle?=False) → str | dict
    Run a subagent → final output. \`agent\` picks a discovered agent. \`schema\` as in completion(). \`handle\` → workflow node { text, output, handle: \`agent://<id>\`, id, agent } (parsed under \`data\` with \`schema\`).
{{/if}}parallel(thunks) → list
    Thunks through a bounded pool (as wide as a \`task\` batch), input order kept; a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages with a barrier between stages; each stage receives the previous stage's result.
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Phase grouping subsequent status lines.
\`\`\`
</prelude>
{{#if spawns}}
<workflow>
Multi-agent work is an acyclic graph in code: one \`agent(…)\` node per step with its handle option ({{#if py}}\`handle=True\`{{/if}}{{#ifAll py js}} / {{/ifAll}}{{#if js}}\`{ handle: true }\`{{/if}}{{#if jl}}{{#ifAny py js}} / {{/ifAny}}\`handle=true\`{{/if}}), \`parallel(thunks)\` for independent nodes, \`pipeline(items, *stages)\` for staged waves. Pass an upstream node's \`handle\` or \`output\` (or a \`write("local://…")\` URI for bulk text) into dependents instead of re-inlining transcripts, and wrap risky nodes in try/except so a failure aborts only its subtree.
</workflow>
{{/if}}
`;
