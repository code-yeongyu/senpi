import type { EvalLanguage } from "./types.ts";

/** Why an omitted run language was filled: the only enabled kernel, or unambiguous code markers (senpi#5154). */
export type EvalLanguageInferenceBasis = "only-enabled-language" | "code-markers";

export interface EvalLanguageInference {
	readonly language: EvalLanguage;
	readonly basis: EvalLanguageInferenceBasis;
}

/** The argument key validation sets when it filled the language, so execution can tell the model. */
export const EVAL_LANGUAGE_INFERRED_KEY = "language_inferred";

interface LanguageSignals {
	/** Any one of these fills the language when the other language shows no signal at all. */
	readonly strong: readonly RegExp[];
	/** These never fill; they only veto a fill for the other language. */
	readonly weak: readonly RegExp[];
}

const PYTHON_IDENTIFIER = "[A-Za-z_]\\w*";
const PYTHON_MODULE = `${PYTHON_IDENTIFIER}(?:\\.${PYTHON_IDENTIFIER})*`;
const PYTHON_IMPORT_ITEM = `${PYTHON_MODULE}(?:[ \\t]+as[ \\t]+${PYTHON_IDENTIFIER})?`;

const SIGNALS: Readonly<Record<"js" | "py", LanguageSignals>> = {
	py: {
		strong: [
			/^[ \t]*def[ \t]+[A-Za-z_]\w*[ \t]*\(/mu,
			new RegExp(
				`^[ \\t]*import[ \\t]+${PYTHON_IMPORT_ITEM}(?:[ \\t]*,[ \\t]*${PYTHON_IMPORT_ITEM})*[ \\t]*$`,
				"mu",
			),
			new RegExp(`^[ \\t]*from[ \\t]+\\.*${PYTHON_MODULE}[ \\t]+import[ \\t]+[\\w(*]`, "mu"),
			/(?<![\w.$])print\(/u,
		],
		weak: [
			/\b(?:None|True|False|elif|lambda|self)\b/u,
			/^[ \t]*(?:if|elif|else|for|while|with|try|except|finally|class|async[ \t]+def)\b.*:[ \t]*(?:#.*)?$/mu,
			/^[ \t]*#/mu,
		],
	},
	js: {
		strong: [
			/\bawait[ \t]+tool\./u,
			/^[ \t]*(?:const|let)[ \t]+[A-Za-z_$[{]/mu,
			/=>/u,
			/\bconsole\.log\(/u,
			/^[ \t]*import[ \t].*\bfrom[ \t]*["']/mu,
			/^[ \t]*import[ \t]*["']/mu,
		],
		weak: [
			/\b(?:null|undefined|function|var|typeof|new)\b/u,
			/===|!==|&&|\|\||\+\+/u,
			/;[ \t]*$/mu,
			/^[ \t]*\/\//mu,
			/[{}][ \t]*$/mu,
		],
	},
};

function signals(code: string, language: "js" | "py"): { readonly strong: boolean; readonly any: boolean } {
	const { strong, weak } = SIGNALS[language];
	const hasStrong = strong.some((pattern) => pattern.test(code));
	return { strong: hasStrong, any: hasStrong || weak.some((pattern) => pattern.test(code)) };
}

/**
 * Classifies a cell body as js or py only on a strong marker of one language with no signal of the other;
 * anything else, including any conflicting signal, is unclassified.
 */
export function classifyEvalCode(code: string): "js" | "py" | undefined {
	const py = signals(code, "py");
	const js = signals(code, "js");
	if (py.strong && !js.any) return "py";
	if (js.strong && !py.any) return "js";
	return undefined;
}

/**
 * The language an omitted run language may be filled with: the only enabled kernel, or, when exactly js and py are
 * enabled, the classified code. Any other case returns undefined and the caller keeps its teaching error.
 */
export function inferEvalLanguage(
	code: unknown,
	languages: readonly EvalLanguage[],
): EvalLanguageInference | undefined {
	const [only] = languages;
	if (languages.length === 1 && only !== undefined) return { language: only, basis: "only-enabled-language" };
	if (languages.length !== 2 || !languages.includes("js") || !languages.includes("py")) return undefined;
	if (typeof code !== "string") return undefined;
	const language = classifyEvalCode(code);
	return language === undefined ? undefined : { language, basis: "code-markers" };
}

export function isEvalLanguageInferenceBasis(value: unknown): value is EvalLanguageInferenceBasis {
	return value === "only-enabled-language" || value === "code-markers";
}

/** The line an inferred-language result leads with, so the model sees the fill and passes language next time. */
export function evalLanguageInferredNote(language: EvalLanguage, basis: EvalLanguageInferenceBasis): string {
	return `${EVAL_LANGUAGE_INFERRED_KEY}: ${language} (${basis}). This eval run omitted language; pass language explicitly.`;
}
