import { DEFAULT_RUN_BUDGET_SECONDS } from "../config/settings.ts";
import type { EvalRuntimeInfo } from "../tool/types.ts";
import { EVAL_PROMPT_TEMPLATE } from "./eval-prompt-template.ts";

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
	/** Kill deadline for a cell's own execution time, as configured; the description states it. */
	readonly runBudgetSeconds?: number;
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
		runBudgetSeconds: String(options.runBudgetSeconds ?? DEFAULT_RUN_BUDGET_SECONDS),
	};
	const description = renderTemplate(EVAL_PROMPT_TEMPLATE, context)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		description,
		promptSnippet: "Run one incremental code cell in a persistent language kernel.",
		promptGuidelines: [
			style === "gpt" && context.monitor === true ? GPT_MONITOR_BATCHING_GUIDELINE : BATCHING_GUIDELINES[style],
			"Use eval reset only when a language kernel must be wiped; reset is scoped to the selected language.",
		],
	};
}

/**
 * System-prompt guideline per emphasis dialect. The default dialect carries
 * maximum emphasis so unmapped models still batch through eval; the others are
 * tuned to what steers that family reliably. The GPT line routes waits to the
 * subscription when `monitor` is reachable, because a GPT model that reads
 * "long cells detach" as the way to wait awaits a `--watch` inside a cell.
 */
const GPT_MONITOR_BATCHING_GUIDELINE =
	"Use eval to compose tool work in one cell; a wait or a long run starts through `tool.monitor` in that cell, so no cell sits on it and nothing polls.";

const BATCHING_GUIDELINES: Record<EvalEmphasisStyle, string> = {
	default:
		"Prefer eval when a step's calls are independent: one cell runs them together and keeps every failure in its result; edits and result-dependent calls go one at a time, each observed before the next.",
	claude:
		"Prefer eval for a step's independent calls: one cell runs them together and keeps every failure in its result.",
	codex: "Route a step's independent calls through one eval cell and inspect every result; a direct tool call is right when one call is sufficient.",
	gpt: "Use eval to batch a step's independent tool calls in one cell and inspect every result; long cells detach on their own and notify on completion, so do not poll.",
	kimi: "Put a step's independent calls into one eval cell with parallel(thunks) and keep every failed item in the result.",
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
