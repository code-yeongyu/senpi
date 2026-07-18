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
	readonly spawnDefaultAgent?: string;
	/** Active model id; selects the emphasis dialect of the batching guidance. */
	readonly modelId?: string;
	/** Preformatted host line (e.g. "darwin arm64 · Apple M5 Max · 18 cores"); enables the host-sizing note. */
	readonly hostLine?: string;
}

/** Prompt dialect for the eval-first batching emphasis. */
export type EvalEmphasisStyle = "default" | "claude" | "codex" | "kimi";

const CLAUDE_MODEL_RE = /(^|[/.:])claude[-.]/i;
const GLM_MODEL_RE = /(^|[/.:@-])glm[-.]?\d/i;
const KIMI_MODEL_RE = /(^|[/.:])kimi[-.]/i;
const OPENAI_MODEL_RE = /(^|[/.:])(gpt|chatgpt|codex)[-.]|(^|[/.:])o[134](?:[-.]|$)/i;

/**
 * Selects the eval-first batching dialect for a model id:
 * - `claude`: Claude/GLM — direct imperatives; both are steered most reliably
 *   by explicit tagged directives (GLM prompting guidance routes to Claude's).
 * - `codex`: OpenAI reasoning families — terse bounded rules, no emphasis spam.
 * - `kimi`: Kimi K-series — maximum-emphasis POSITIVE imperatives (uppercase/
 *   bold DO-framing); all-caps NEVER prohibitions stay out because they make
 *   K-series overthink instead of comply.
 * - `default`: everything else (and no model) — maximum-emphasis fallback.
 */
export function evalEmphasisStyle(modelId: string | undefined): EvalEmphasisStyle {
	if (!modelId) return "default";
	if (CLAUDE_MODEL_RE.test(modelId) || GLM_MODEL_RE.test(modelId)) return "claude";
	if (KIMI_MODEL_RE.test(modelId)) return "kimi";
	if (OPENAI_MODEL_RE.test(modelId)) return "codex";
	return "default";
}

type ContextValue = string | boolean;
type Context = Readonly<Record<string, ContextValue>>;
type EvalPromptExample = {
	readonly caption: string;
	readonly language: keyof EnabledLanguages;
	readonly title: string;
	readonly code: string;
};

// senpi ToolDefinition has no examples field, so description embeds the examples.
// ADAPTATION: payloads diverge from omp's json-config chain to teach batch read,
// comprehension filtering, and parallel tool.<name> fan-out while keeping the
// three-cell reuse narrative.
const REUSE_CHAIN_EXAMPLES = [
	{
		caption: "First call — set up once",
		language: "py",
		title: "collect targets",
		code: "from pathlib import Path\nfrom collections import Counter\nfiles = [p for p in Path('src').rglob('*.ts') if 'test' not in p.parts]\nprint(len(files))",
	},
	{
		caption: "Second call — reuse `files`, batch-read in one cell",
		language: "py",
		title: "scan usages",
		code: "hits = Counter()\nfor p in files:\n    hits[p.name] = read(p).count('legacyClient')\ndisplay({k: v for k, v in hits.items() if v})",
	},
	{
		caption: "Third call — reuse results, fan out session tools in parallel",
		language: "py",
		title: "confirm callsites",
		code: "dirs = ['src/core', 'src/tools']\ndisplay(parallel([lambda d=d: tool.grep({'pattern': 'legacyClient', 'path': d}) for d in dirs]))",
	},
] as const satisfies readonly EvalPromptExample[];

const EVAL_PROMPT_TEMPLATE = `Run one step of code in a persistent kernel.

<instruction>
**One eval call = one cell = one logical step.** State persists per language across separate eval calls and tool calls{{#if spawns}}, and \`task\` subagents{{/if}} — define helpers, datasets, and clients in one call, then later calls reuse them directly.

Work incrementally: imports in one call, define in the next, test, then use — each its own eval call. Re-run setup ONLY after \`reset\`, a kernel crash, or a \`NameError\`/\`ReferenceError\` proving the state is gone.

{{#if styleClaude}}<eval_first_batching>
\`eval\` is your default execution surface: if a step needs more than one tool call, write ONE cell that performs the whole step — never issue the calls one at a time.
- Enumerate every lookup the step needs, then run all independent ones simultaneously with \`parallel(thunks)\` inside the cell; keep calls sequential only when one result feeds the next.
- Write real code around the calls: loop or comprehend over file sets with \`read()\`/stdlib, branch per case, and wrap risky calls in try/except so one failure degrades only its item — recover or retry inside the cell, keep the batch alive.
- Post-process \`tool.<name>()\` results programmatically and return distilled facts, not raw dumps.
</eval_first_batching>{{/if}}{{#if styleCodex}}Route multi-call steps through eval: one cell per step, independent lookups dispatched together via \`parallel(thunks)\`; keep work sequential only when one result determines the next action.
- Loop or comprehend over file sets with \`read()\`/stdlib instead of reading files one call at a time; post-process \`tool.<name>()\` results programmatically.
- Wrap failable calls in try/except inside the cell; a failed item degrades only itself. After two distinct failed strategies for the same fact, fall back to direct tool calls.
- Reduce large results in-kernel to the facts the task needs before returning.{{/if}}{{#if styleKimi}}**EVAL IS YOUR SUPERPOWER — MAKE IT YOUR DEFAULT WAY TO ACT.** Before any step, think: "how do I execute this WHOLE step in ONE parallelized cell?" — then write that ONE cell.
- **BATCH EVERYTHING AT ONCE:** enumerate EVERY independent lookup the step needs and dispatch them ALL simultaneously with \`parallel(thunks)\` in that cell; keep calls sequential only when one result feeds the next.
- **WRITE REAL CODE, NOT CALL CHAINS:** loop or comprehend over file sets with \`read()\`/stdlib, post-process \`tool.<name>()\` results programmatically, and put try/except around each risky call so the rest of the batch completes.
- **DISTILL IN-KERNEL:** filter and aggregate results in code, then return ONLY the distilled facts.{{/if}}{{#if styleDefault}}**EVAL IS YOUR PRIMARY EXECUTION SURFACE.** Any step that needs MORE THAN ONE tool call MUST be written as ONE cell — NEVER as a chain of single tool calls.
- **PLAN THE WHOLE STEP, THEN BATCH IT.** Enumerate every read/search/lookup the step needs and dispatch ALL independent ones through \`parallel(thunks)\` in one cell.
- **WRITE REAL CODE, NOT CALL LISTS.** Loop or comprehend over file sets with \`read()\`/stdlib, branch \`if\`/\`else\` per case, post-process \`tool.<name>()\` results programmatically, and wrap EVERY risky call in try/except so ONE failure NEVER kills the batch.
- **DISTILL IN-KERNEL.** Filter, diff, and aggregate in code before returning; return facts, NOT dumps.{{/if}}
{{#if hostLine}}
Host: {{hostLine}} — cells execute here. Size \`parallel(thunks)\` pools to its cores; \`tool.<name>()\` shell commands must fit this platform, even when the code you are writing targets another machine.
{{/if}}

Fields:

- \`language\` — {{#if py}}\`"py"\` IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}\`"js"\` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}, {{/ifAny}}\`"rb"\` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}, {{/ifAny}}\`"jl"\` persistent Julia kernel{{/if}}.
- \`code\` — cell body, verbatim. Newlines/quotes JSON-encoded; no fences, no headers.
- \`title\` (optional) — short transcript label (e.g. \`"imports"\`).
- \`timeout\` (optional) — seconds. Raise only for heavy compute or long{{#if spawns}} non-agent{{/if}} tool calls.
- \`reset\` (optional) — wipe this language's kernel first.{{#ifAll py js}} Per-language: a \`py\` reset never touches the JS VM.{{/ifAll}}

{{#if py}}Live event loop: use top-level \`await\` directly; \`asyncio.run(…)\` raises "cannot be called from a running event loop".{{/if}}
{{#if js}}JS runs under Node.js worker: top-level \`await\`/\`return\` work; \`fetch\`/\`Buffer\` available.{{/if}}
{{#if rb}}Ruby: synchronous; helper options are keyword args{{#if spawns}} (e.g. \`output("id", limit: 2)\`){{/if}}; the last expression auto-displays unless it is \`nil\`, an assignment, or a definition (like IRB).{{/if}}
{{#if jl}}Julia: synchronous; helper options are standard keyword args{{#if spawns}} (e.g. \`output("id", limit=2)\`){{/if}}; the last expression auto-displays unless it is an assignment or a definition (like the Julia REPL).{{/if}}
On error, fix and re-run only the failing step — prior calls' state survives.
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
    Task/agent output by id. \`format\` selects full (\`"raw"\`) or trailing (\`"tail"\`) output.
{{/if}}tool.<name>(args) → unknown
    Invoke any session tool; \`args\` = its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). \`model\`: \`"smol"\` fast | \`"default"\` session | \`"slow"\` most capable. \`schema\` (JSON-Schema) → structured output, parsed object.
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, handle?=False) → str | dict
    Run a subagent → final output. \`agent\` picks another discovered agent; omit it to use \`{{spawnDefaultAgent}}\`. \`schema\` as in completion(). Background via \`local://\` files named in the prompt. \`handle\` → DAG node dict { text, output, handle: \`agent://<id>\`, id, agent } (parsed under \`data\` when \`schema\` set).
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
<dag>
Pipe handles through stage helpers to build a dependency graph — acyclic waves:
- **Name nodes.** Capture each \`agent(…, {{#if py}}handle=True{{/if}}{{#if js}}{ handle: true }{{/if}}{{#if jl}}handle=true{{/if}})\` result; carries \`handle\` (\`agent://<id>\`) + \`output\`.
- **Wire edges by reference.** Put an upstream node's \`handle\`/\`output\` in the dependent stage's prompt — large transcript never re-inlined. Bulk: \`write("local://<name>.md", …)\`, pass the URI.
- **\`pipeline(items, *stages)\` = staged waves**, barrier between stages (every item clears stage N before any enters N+1). **\`parallel(thunks)\` = one wave** of independent nodes.
- **Isolate failure.** A raising node re-raises the lowest-index error, aborts its wave; wrap risky nodes in try/except so a failure degrades only its dependent subtree, independent branches finish.
- **Acyclic only.** A node never waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names (\`data\`, \`sessions\`, helpers, imports) survive into the next eval call — reuse them; NEVER re-import, re-require, or re-declare a helper. Re-read a file only if it may have changed since the last read.
</critical>`;

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
		spawnDefaultAgent,
		styleClaude: style === "claude",
		styleCodex: style === "codex",
		styleKimi: style === "kimi",
		styleDefault: style === "default",
		hostLine: options.hostLine ?? "",
	};
	const examples = REUSE_CHAIN_EXAMPLES.filter((example) => enabled[example.language])
		.map((example) => {
			const call = { language: example.language, title: example.title, code: example.code };
			return `### ${example.caption}\n\`\`\`json\n${JSON.stringify(call, null, 2)}\n\`\`\``;
		})
		.join("\n\n");
	const description = [
		renderTemplate(EVAL_PROMPT_TEMPLATE, context)
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		examples === "" ? "" : `<examples>\n${examples}\n</examples>`,
	]
		.filter((part) => part !== "")
		.join("\n\n");
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
