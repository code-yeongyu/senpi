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

type ContextValue = string | boolean;
type Context = Readonly<Record<string, ContextValue>>;

const EVAL_PROMPT_TEMPLATE = `Run one step of code in a persistent kernel.

<instruction>
**One eval call = one cell = one logical step.** State persists per language across separate eval calls and tool calls — define helpers, datasets, and clients in one call, then later calls reuse them directly.

Work incrementally: imports in one call, define in the next, test, then use — each its own eval call. Re-run setup ONLY after \`reset\`, a kernel crash, or a \`NameError\`/\`ReferenceError\` proving the state is gone. Parallelize work *within* a cell with the \`parallel(thunks)\` helper, not by batching steps.

Fields:

- \`language\` — {{#if py}}\`"py"\` IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}\`"js"\` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}, {{/ifAny}}\`"rb"\` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}, {{/ifAny}}\`"jl"\` persistent Julia kernel{{/if}}.
- \`code\` — cell body, verbatim. Newlines/quotes JSON-encoded; no fences, no headers.
- \`title\` (optional) — short transcript label (e.g. \`"imports"\`).
- \`timeout\` (optional) — seconds. Raise only for heavy compute or long delegated tool calls.
- \`reset\` (optional) — wipe this language's kernel first.{{#ifAll py js}} Per-language: a \`py\` reset never touches the JS VM.{{/ifAll}}

{{#if py}}Live event loop: use top-level \`await\` directly; \`asyncio.run(...)\` raises "cannot be called from a running event loop".{{/if}}
{{#if js}}JS runs under Node.js worker: top-level \`await\`/\`return\` work; \`fetch\`/\`Buffer\` available.{{/if}}
{{#if rb}}Ruby: synchronous; helper options are keyword args; the last expression auto-displays unless it is \`nil\`, an assignment, or a definition.{{/if}}
{{#if jl}}Julia: synchronous; helper options are standard keyword args; the last expression auto-displays unless it is an assignment or a definition.{{/if}}
On error, fix and re-run only the failing step — prior calls' state survives.
</instruction>

<prelude>
{{#ifAll py js}}Same helpers + arg order, both runtimes. Python: sync, options = trailing kwargs. JS: async/\`await\`able, options = ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; options = trailing kwargs.{{/if}}{{#if js}}Async/\`await\`able; options = ONE trailing object literal, never positional.{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, options = trailing keyword args.{{/if}}{{#if jl}} Julia: sync, options = trailing keyword args.{{/if}}
\`\`\`
display(value) -> None
    Cell result; figures/images/dataframes shown natively.
print(value, ...) -> None
    Text stream.
read(path, offset?=1, limit?=None) -> str
    File as text; offset/limit are 1-indexed lines.
write(path, content) -> str
    Write file, creating parents, and return the resolved path.
env(key?=None, value?=None) -> str | None | dict
    No args -> full env dict; one -> value of key; two -> set key=value and return value.
tool.<name>(args) -> unknown
    Invoke any active session tool; args = its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) -> str | dict
    Oneshot, stateless completion. model "default" uses the session model; schema is JSON Schema for structured results.
parallel(thunks) -> list
    Thunks through a bounded pool, input order kept; returns when all finish, a throwing thunk propagates.
pipeline(items, ...stages) -> list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result.
log(message) -> None
    Progress line above the status tree.
phase(title) -> None
    Phase grouping subsequent status lines.
\`\`\`
</prelude>

<critical>
Prior top-level names survive into the next eval call — reuse them; NEVER re-import, re-require, or re-declare a helper. Re-read a file only if it may have changed since the last read. Re-run setup only after \`reset\`, a crash, or a \`NameError\`/\`ReferenceError\`.
</critical>`;

export function buildEvalPrompt(enabled: EnabledLanguages): EvalPromptParts {
	if (!enabled.py && !enabled.js && !enabled.rb && !enabled.jl) {
		throw new Error("no kernels enabled for eval prompt");
	}
	const context: Context = {
		py: enabled.py,
		js: enabled.js,
		rb: enabled.rb,
		jl: enabled.jl,
	};
	const description = renderTemplate(EVAL_PROMPT_TEMPLATE, context)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return {
		description,
		promptSnippet: "Run one incremental code cell in a persistent language kernel.",
		promptGuidelines: [
			"Use eval for incremental code execution when a persistent JS, Python, Ruby, or Julia kernel is available.",
			"Use eval reset only when a language kernel must be wiped; reset is scoped to the selected language.",
		],
	};
}

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
