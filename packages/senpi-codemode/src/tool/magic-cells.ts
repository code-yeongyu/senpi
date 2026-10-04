import type { EvalLanguage } from "./types.ts";

export type MagicCell =
	| { readonly kind: "pip"; readonly args: string }
	| { readonly kind: "environment"; readonly mode: "managed" | "project" }
	| { readonly kind: "load"; readonly target: string };

const HOST_MAGICS = ["pip", "environment", "load"] as const;
const LOAD_LANGUAGES: ReadonlySet<EvalLanguage> = new Set(["py", "js"]);
const COMMENT_PREFIX: Partial<Record<EvalLanguage, string>> = { py: "#", js: "//" };
type HostMagic = (typeof HOST_MAGICS)[number];

export class MagicCellError extends Error {
	readonly name = "MagicCellError";
}

function joinContinuations(lines: readonly string[]): string[] {
	const joined: string[] = [];
	let pending: string | undefined;
	for (const line of lines) {
		const current = pending === undefined ? line : `${pending} ${line.trim()}`;
		if (current.trimEnd().endsWith("\\")) pending = current.trimEnd().slice(0, -1).trimEnd();
		else {
			joined.push(current);
			pending = undefined;
		}
	}
	if (pending !== undefined) joined.push(pending);
	return joined;
}

function hostMagicOf(language: EvalLanguage, line: string): HostMagic | undefined {
	const match = /^%([A-Za-z]+)(?:\s|$)/.exec(line.trim());
	const name = match?.[1];
	const magic = HOST_MAGICS.find((candidate) => candidate === name);
	if (magic === "load") return LOAD_LANGUAGES.has(language) ? magic : undefined;
	return language === "py" ? magic : undefined;
}

/**
 * A cell whose first code line (blank and comment lines skipped) is a host magic runs on the host instead of
 * the interpreter: `%pip` and `%environment` in Python, `%load` in Python and JavaScript. In Python a trailing
 * backslash continues the line. Any other cell is ordinary code, so a magic-looking line later in the cell
 * (say, inside a string) is left alone. A magic followed by more code is refused, because the host step must
 * finish before the code that depends on it runs.
 */
export function parseMagicCell(language: EvalLanguage, code: string): MagicCell | undefined {
	const comment = COMMENT_PREFIX[language];
	// Comment lines go before Python's backslash continuations are joined: Python never continues a comment line.
	const raw = code.split("\n").filter((line) => comment === undefined || !line.trim().startsWith(comment));
	const lines = (language === "py" ? joinContinuations(raw) : raw).filter((line) => line.trim() !== "");
	const first = lines[0] ?? "";
	const magic = hostMagicOf(language, first);
	if (magic === undefined) return undefined;
	if (lines.length > 1)
		throw new MagicCellError(`put %${magic} on its own cell, then run the code that uses it in the next cell`);
	const args = first.trim().slice(`%${magic}`.length).trim();
	if (magic === "pip") return { kind: "pip", args };
	if (magic === "load") {
		if (args === "") throw new MagicCellError("%load takes one argument: the path of the file to run");
		return { kind: "load", target: args };
	}
	if (args === "managed" || args === "project") return { kind: "environment", mode: args };
	throw new MagicCellError("%environment takes one argument: managed or project");
}
