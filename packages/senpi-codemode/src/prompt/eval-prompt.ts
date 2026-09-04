import type { EvalRuntimeInfo } from "../tool/types.ts";

export interface EnabledLanguages {
	readonly py: boolean;
	readonly js: boolean;
	readonly rb: boolean;
	readonly jl: boolean;
}

export interface EvalPromptParts {
	readonly description: string;
	readonly promptSnippet: string;
	readonly promptGuidelines: readonly string[];
}

export interface EvalPromptOptions {
	readonly spawns: boolean;
	/** Whether the session registry exposes the monitor tool through eval. */
	readonly monitor?: boolean;
	readonly spawnDefaultAgent?: string;
	/** Active model id; selects the emphasis dialect of the batching guidance. */
	readonly modelId?: string;
	/** Preformatted host line (e.g. "darwin arm64 · Apple M5 Max · 18 cores"); enables the host-sizing note. */
	readonly hostLine?: string;
	/** Identity of the in-process js kernel; a bun runtime swaps the Node.js worker line for the Bun one. */
	readonly jsRuntime?: EvalRuntimeInfo;
	/** Absolute path of the active bun-1-4 skill; rendered as a MUST READ pointer only on a bun kernel. */
	readonly bunSkillPath?: string;
}

/** Prompt dialect for the eval-first batching emphasis. */
export type EvalEmphasisStyle = "default" | "claude" | "codex" | "gpt" | "kimi";

const CLAUDE_MODEL_RE = /(^|[/.:])claude[-.]/i;
const GLM_MODEL_RE = /(^|[/.:@-])glm[-.]?\d/i;
const KIMI_MODEL_RE = /(^|[/.:])kimi[-.]/i;
const OPENAI_MODEL_RE = /(^|[/.:])(gpt|chatgpt|codex)[-.]|(^|[/.:])o[134](?:[-.]|$)/i;

/**
 * Selects the eval-first batching dialect for a model id:
 * - `claude`: Claude/GLM — direct imperatives; both are steered most reliably
 *   by explicit tagged directives (GLM prompting guidance routes to Claude's).
 * - `gpt`: GPT models — terse composition-forward rules that direct detached
 *   cells to notify on completion instead of being polled.
 * - `codex`: Other OpenAI reasoning families — terse bounded rules, no emphasis spam.
 * - `kimi`: Kimi K-series — maximum-emphasis POSITIVE imperatives (uppercase/
 *   bold DO-framing); all-caps NEVER prohibitions stay out because they make
 *   K-series overthink instead of comply.
 * - `default`: everything else (and no model) — maximum-emphasis fallback.
 */
/** True only for GPT model ids that receive the terse eval composition dialect. */
export function isGptCodeModeModel(modelId: string | undefined): boolean {
	return modelId !== undefined && /(^|[/.:])gpt[-.]/iu.test(modelId);
}

export function evalEmphasisStyle(modelId: string | undefined): EvalEmphasisStyle {
	if (!modelId) return "default";
	if (isGptCodeModeModel(modelId)) return "gpt";
	if (CLAUDE_MODEL_RE.test(modelId) || GLM_MODEL_RE.test(modelId)) return "claude";
	if (KIMI_MODEL_RE.test(modelId)) return "kimi";
	if (OPENAI_MODEL_RE.test(modelId)) return "codex";
	return "default";
}

type ContextValue = string | boolean;
type Context = Readonly<Record<string, ContextValue>>;
const EVAL_PROMPT_TEMPLATE = `Run one step of code in a persistent kernel.

<instruction>
**One eval call = one cell = one logical step.** Top-level names persist per language across eval calls and tool calls{{#if spawns}} and \`task\` subagents{{/if}}: define helpers, datasets, and clients once and reuse them; never re-import, re-declare, or re-read what an earlier cell already holds. Rebuild state only after \`reset\`, a kernel restart, or a \`NameError\`/\`ReferenceError\` proving it is gone, and check a sentinel variable first so a blind re-run cannot duplicate side effects.

{{#if styleClaude}}<eval_first_batching>
\`eval\` is your default execution surface: if a step needs more than one tool call, write ONE cell that performs the whole step — never issue the calls one at a time.
- Enumerate every lookup the step needs, then run all independent ones simultaneously with \`parallel(thunks)\` inside the cell; keep calls sequential only when one result feeds the next.
- Write real code around the calls: loop or comprehend over file sets with \`read()\`/stdlib, branch per case, and wrap risky calls in try/except so one failure degrades only its item — recover or retry inside the cell, keep the batch alive.
- Post-process \`tool.<name>()\` results programmatically — filter, join, aggregate — and return distilled facts, not raw dumps.
{{#if monitor}}- Start long-running work (build, test run, deploy, or watch) through \`tool.monitor({ command, filter })\`, putting the decisive-line filter inside the same cell, then keep working until its event wakes the turn.{{/if}}
</eval_first_batching>{{/if}}{{#if styleGpt}}<gpt_eval_dialect>
GPT eval: compose multi-tool work inside one cell with \`tool.<name>(args)\` and \`parallel(thunks)\`; do not split a planned step into serial tool calls.
- Long pure-compute cells detach on timeout and notify on completion. Do not poll or re-run them; use \`eval({ action: "peek"|"stop", cell_id })\` only to inspect or stop a detached cell.
- Filter, join, and aggregate tool results in the cell; return only decision-relevant facts.
{{#if monitor}}- For long-running build, test run, deploy, or watch work, start \`tool.monitor({ command, filter })\` with the decisive-line filter in the same cell; keep working until its event wakes the turn.{{/if}}
</gpt_eval_dialect>{{/if}}{{#if styleCodex}}Route multi-call steps through eval: one cell per step, independent lookups dispatched together via \`parallel(thunks)\`; keep work sequential only when one result determines the next action.
- Loop or comprehend over file sets with \`read()\`/stdlib instead of reading files one call at a time; post-process \`tool.<name>()\` results programmatically — filter, join, aggregate.
- Wrap failable calls in try/except inside the cell; a failed item degrades only itself. After two distinct failed strategies for the same fact, fall back to direct tool calls.
- Reduce large results in-kernel to the facts the task needs before returning.
{{#if monitor}}- Long-running build/test/deploy/watch work: start \`tool.monitor({ command, filter })\` with the decisive-line filter inside the same cell, then continue working until its event wakes the turn.{{/if}}{{/if}}{{#if styleKimi}}**EVAL IS YOUR SUPERPOWER — MAKE IT YOUR DEFAULT WAY TO ACT.** Before any step, think: "how do I execute this WHOLE step in ONE parallelized cell?" — then write that ONE cell.
- **BATCH EVERYTHING AT ONCE:** enumerate EVERY independent lookup the step needs and dispatch them ALL simultaneously with \`parallel(thunks)\` in that cell; keep calls sequential only when one result feeds the next.
- **WRITE REAL CODE, NOT CALL CHAINS:** loop or comprehend over file sets with \`read()\`/stdlib, post-process \`tool.<name>()\` results programmatically, and put try/except around each risky call so the rest of the batch completes.
- **DISTILL IN-KERNEL:** filter, join, and aggregate \`tool.<name>()\` results in code, then return ONLY the distilled facts.
{{#if monitor}}- **DO start long-running build, test run, deploy, or watch work with \`tool.monitor({ command, filter })\`, put the decisive-line filter INSIDE THE SAME CELL, and KEEP WORKING until its event wakes the turn.**{{/if}}{{/if}}{{#if styleDefault}}**EVAL IS YOUR PRIMARY EXECUTION SURFACE.** Any step that needs MORE THAN ONE tool call MUST be written as ONE cell — NEVER as a chain of single tool calls.
- **PLAN THE WHOLE STEP, THEN BATCH IT.** Enumerate every read/search/lookup the step needs and dispatch ALL independent ones through \`parallel(thunks)\` in one cell.
- **WRITE REAL CODE, NOT CALL LISTS.** Loop or comprehend over file sets with \`read()\`/stdlib, branch \`if\`/\`else\` per case, post-process \`tool.<name>()\` results programmatically, and wrap EVERY risky call in try/except so ONE failure NEVER kills the batch.
- **DISTILL IN-KERNEL.** Filter, join, diff, and aggregate in code before returning; return facts, NOT dumps.
{{#if monitor}}- **LONG-RUNNING build, test run, deploy, or watch work MUST start with \`tool.monitor({ command, filter })\`, with the decisive-line filter INSIDE THE SAME CELL; KEEP WORKING until its event wakes the turn.**{{/if}}{{/if}}
{{#if hostLine}}
Host: {{hostLine}} — cells execute here. Size \`parallel(thunks)\` pools to its cores; \`tool.<name>()\` shell commands must fit this platform, even when the code you are writing targets another machine.
{{/if}}

Fields:

- \`language\` — {{#if py}}\`"py"\` IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}\`"js"\` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}, {{/ifAny}}\`"rb"\` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}, {{/ifAny}}\`"jl"\` persistent Julia kernel{{/if}}.
- \`code\` — cell body, verbatim. Newlines/quotes JSON-encoded; no fences, no headers.
- \`summary\` (REQUIRED for run) — ONE line in the USER'S conversational language stating WHAT this cell does and FOR WHAT PURPOSE (e.g. Korean conversation -> "src 전체에서 legacyClient 사용처 집계"); shown in the TUI while the cell runs; >80 chars is force-truncated.
- \`timeout\` (optional) — seconds; raises the wall-clock kill deadline (default 1800s, never paused by tool calls, a killed cell notifies you). It does not hold the turn: interactive sessions detach the cell at a ~60s foreground window and it keeps running to the deadline.
- \`on_timeout\` (optional) — \`"detach"\` (interactive default) frees the turn at the foreground window; \`"error"\` (print/json default) interrupts at the full \`timeout\` for deadline-sensitive work.
- \`reset\` (optional) — wipe this language's kernel first.{{#ifAll py js}} Per-language: a \`py\` reset never touches the JS VM.{{/ifAll}}
- \`action\` (optional) — defaults to \`"run"\`. A detached cell returns its id: \`eval({ action: "peek", cell_id })\` reads buffered output, \`eval({ action: "stop", cell_id })\` cancels it (the result says whether kernel state survived).

A detached cell keeps its language kernel busy until it finishes; another language can continue. Do not re-run a detached cell (the busy error names its cell id and output tail): completion arrives as one notification with the final value or error and the buffered output.

{{#if py}}Live event loop: use top-level \`await\` directly; \`asyncio.run(…)\` raises "cannot be called from a running event loop".{{/if}}
{{#if js}}{{#if jsBun}}JS runs in-process on Bun {{jsVersion}}: top-level \`await\`/\`return\` work; \`Bun.*\` builtins available.{{#if bunSkillPath}} MUST READ the bun-1-4 skill at {{bunSkillPath}} before your first js cell — its builtins replace the npm packages you would otherwise install.{{/if}}{{else}}JS runs under Node.js worker: top-level \`await\`/\`return\` work; \`fetch\`/\`Buffer\` available.{{/if}}{{/if}}
{{#if rb}}Ruby: synchronous; helper options are keyword args{{#if spawns}} (e.g. \`output("id", limit: 2)\`){{/if}}; the last expression auto-displays unless it is \`nil\`, an assignment, or a definition (like IRB).{{/if}}
{{#if jl}}Julia: synchronous; helper options are standard keyword args{{#if spawns}} (e.g. \`output("id", limit=2)\`){{/if}}; the last expression auto-displays unless it is an assignment or a definition (like the Julia REPL).{{/if}}
On error, fix and re-run only the failing step; a normal error keeps state, while a timeout or stop message says whether the kernel restarted.
</instruction>

<prelude>
{{#ifAll py js}}Same helpers + arg order, both runtimes. Python: sync, options = trailing kwargs. JS: async/\`await\`able, options = ONE trailing object literal, never positional (extras throw).{{else}}{{#if py}}Sync; options = trailing kwargs.{{/if}}{{#if js}}Async/\`await\`able; options = ONE trailing object literal, never positional (extras throw).{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, options = trailing keyword args.{{/if}}{{#if jl}} Julia: sync, options = trailing keyword args.{{/if}}
\`\`\`
display(value) → None
    Cell output; figures/images/dataframes shown natively.
print(value, ...) → None
    Text output.
read(path, offset?=1, limit?=None) → str
    File as text; offset/limit are 1-indexed lines. Accepts \`local://…\`.
write(path, content) → str
    Write file (creates parents) → resolved path. \`local://…\` persists across turns/subagents.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value of \`key\`; two → set \`key=value\`, return value.
{{#if spawns}}output(*ids, format?="raw", offset?=None, limit?=None) → str | dict | list[dict]
    Task/agent output by id. Reads immediately: running tasks return their status; \`format\` selects full (\`"raw"\`) or trailing (\`"tail"\`) output.
{{/if}}tool.<name>(args) → unknown
    Invoke any session tool; \`args\` = its parameter object.
tool_schema(name?) → dict
    Parameter schema of a tool (omit \`name\` to list tool names); check it before a first call, and a failed call also returns the expected parameters.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). \`model\`: \`"smol"\` fast | \`"default"\` session | \`"slow"\` most capable. \`schema\` (JSON-Schema) → structured output, parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, handle?=False) → str | dict
    Run a subagent → final output. \`agent\` picks a discovered agent; omit it to use \`{{spawnDefaultAgent}}\`. \`schema\` as in completion(). \`handle\` → workflow node { text, output, handle: \`agent://<id>\`, id, agent } (parsed under \`data\` with \`schema\`).
{{#if js}}    JS: options are ONE trailing object — agent(prompt, { agent, schema, handle }).
{{/if}}{{/if}}parallel(thunks) → list
    Thunks through a bounded pool (wide as a \`task\` batch — don't pre-shrink), input order kept; returns when all finish, a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result.
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Phase grouping subsequent status lines.
\`\`\`
</prelude>
{{#if spawns}}
<workflow>
Build multi-agent work as an acyclic graph in code: one \`agent(…)\` node per step with its handle option ({{#if py}}\`handle=True\`{{/if}}{{#ifAll py js}} / {{/ifAll}}{{#if js}}\`{ handle: true }\`{{/if}}{{#if jl}}\`handle=true\`{{/if}}), \`parallel(thunks)\` for one wave of independent nodes, \`pipeline(items, *stages)\` for staged waves with a barrier between stages. Wire dependents by passing the upstream node's \`handle\` or \`output\` (or a \`write("local://…")\` URI for bulk text) in their prompt instead of re-inlining transcripts; wrap risky nodes in try/except so a failure aborts only its dependent subtree; a node never waits on its own descendant.
</workflow>
{{/if}}
`;

export function buildEvalPrompt(
	enabled: EnabledLanguages,
	options: EvalPromptOptions = { spawns: false },
): EvalPromptParts {
	if (!enabled.py && !enabled.js && !enabled.rb && !enabled.jl) {
		throw new Error("no kernels enabled for eval prompt");
	}
	const spawnDefaultAgent = options.spawnDefaultAgent ?? "task";
	const style = evalEmphasisStyle(options.modelId);
	const context: Context = {
		py: enabled.py,
		js: enabled.js,
		rb: enabled.rb,
		jl: enabled.jl,
		spawns: options.spawns,
		monitor: options.monitor === true,
		spawnDefaultAgent,
		styleClaude: style === "claude",
		styleCodex: style === "codex",
		styleGpt: style === "gpt",
		styleKimi: style === "kimi",
		styleDefault: style === "default",
		hostLine: options.hostLine ?? "",
		jsBun: options.jsRuntime?.name === "bun",
		jsVersion: options.jsRuntime?.version ?? "",
		bunSkillPath: options.bunSkillPath ?? "",
	};
	const description = renderTemplate(EVAL_PROMPT_TEMPLATE, context)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		description,
		promptSnippet: "Run one incremental code cell in a persistent language kernel.",
		promptGuidelines: [
			BATCHING_GUIDELINES[style],
			"Use eval reset only when a language kernel must be wiped; reset is scoped to the selected language.",
		],
	};
}

/**
 * System-prompt guideline per emphasis dialect. The default dialect carries
 * maximum emphasis so unmapped models still batch through eval; the others are
 * tuned to what steers that family reliably.
 */
const BATCHING_GUIDELINES: Record<EvalEmphasisStyle, string> = {
	default:
		"**EVAL FIRST.** Any step needing MORE THAN ONE tool call MUST be ONE eval cell: run independent calls in parallel, wrap risky calls in try/except, and return distilled facts — NEVER a chain of single tool calls.",
	claude:
		"Prefer eval for any step needing more than one tool call: one cell that runs independent calls in parallel, handles per-call failures in code, and returns distilled facts.",
	codex: "Route multi-call steps through eval: one cell per step, independent calls dispatched in parallel; fall back to direct tool calls when one call is sufficient or each result changes the next decision.",
	gpt: "Use eval to compose tool work in one cell; long cells detach on timeout and notify on completion, so do not poll.",
	kimi: "**EVAL IS YOUR SUPERPOWER — DEFAULT TO IT.** Execute EVERY multi-call step as ONE eval cell: run ALL independent calls simultaneously via parallel(thunks), handle failures per item in code, and return ONLY distilled facts.",
};

function renderTemplate(template: string, context: Context): string {
	let index = 0;
	const [rendered, nextIndex] = renderUntil(template, context, index, []);
	index = nextIndex;
	if (index !== template.length) {
		throw new Error("unexpected template close tag");
	}
	return rendered;
}

function renderUntil(
	template: string,
	context: Context,
	start: number,
	stopTags: readonly string[],
): readonly [string, number, string?] {
	let rendered = "";
	let index = start;
	while (index < template.length) {
		const open = template.indexOf("{{", index);
		if (open < 0) {
			return [rendered + template.slice(index), template.length];
		}
		rendered += template.slice(index, open);
		const close = template.indexOf("}}", open + 2);
		if (close < 0) {
			throw new Error("unterminated template tag");
		}
		const tag = template.slice(open + 2, close).trim();
		index = close + 2;
		if (stopTags.includes(tag)) {
			return [rendered, index, tag];
		}
		if (tag.startsWith("#")) {
			const [block, nextIndex] = renderBlock(template, context, index, tag);
			rendered += block;
			index = nextIndex;
			continue;
		}
		if (tag.startsWith("/")) {
			throw new Error(`unexpected template close tag ${tag}`);
		}
		rendered += valueFor(tag, context);
	}
	return [rendered, index];
}

function renderBlock(template: string, context: Context, start: number, openTag: string): readonly [string, number] {
	const [kind, ...names] = openTag.slice(1).split(/\s+/);
	const closeTag = `/${kind}`;
	const [truthyText, afterTruthy, stopTag] = renderUntil(template, context, start, ["else", closeTag]);
	let falseyText = "";
	let end = afterTruthy;
	if (stopTag === "else") {
		const [elseText, afterElse, elseStop] = renderUntil(template, context, afterTruthy, [closeTag]);
		if (elseStop !== closeTag) {
			throw new Error(`missing close tag for ${kind}`);
		}
		falseyText = elseText;
		end = afterElse;
	} else if (stopTag !== closeTag) {
		throw new Error(`missing close tag for ${kind}`);
	}
	return [condition(kind, names, context) ? truthyText : falseyText, end];
}

function condition(kind: string, names: readonly string[], context: Context): boolean {
	if (kind === "if") {
		return names.length === 1 && Boolean(context[names[0]]);
	}
	if (kind === "ifAll") {
		return names.length > 0 && names.every((name) => Boolean(context[name]));
	}
	if (kind === "ifAny") {
		return names.length > 0 && names.some((name) => Boolean(context[name]));
	}
	throw new Error(`unknown template condition ${kind}`);
}

function valueFor(name: string, context: Context): string {
	const value = context[name];
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "boolean" || value === undefined) {
		return "";
	}
	return String(value);
}
