import type { EvalLanguage } from "./types.ts";

export type MagicCell =
	| { readonly kind: "pip"; readonly args: string }
	| { readonly kind: "environment"; readonly mode: "managed" | "project" }
	| { readonly kind: "load"; readonly target: string };

const HOST_MAGICS = ["pip", "environment", "load"] as const;
const LOAD_LANGUAGES: ReadonlySet<EvalLanguage> = new Set(["py", "js"]);
type HostMagic = (typeof HOST_MAGICS)[number];

export class MagicCellError extends Error {
	readonly name = "MagicCellError";
}

function hostMagicOf(language: EvalLanguage, line: string): HostMagic | undefined {
	const match = /^%([A-Za-z]+)(?:\s|$)/.exec(line.trim());
	const name = match?.[1];
	const magic = HOST_MAGICS.find((candidate) => candidate === name);
	if (magic === "load") return LOAD_LANGUAGES.has(language) ? magic : undefined;
	return language === "py" ? magic : undefined;
}

/**
 * A Python cell whose only non-blank line is `%pip ...` or `%environment ...` runs on the host instead of
 * the interpreter. Any other cell is ordinary; a cell that mixes one of these lines with code is refused,
 * because the install must finish before the code that imports from it runs.
 */
export function parseMagicCell(language: EvalLanguage, code: string): MagicCell | undefined {
	const lines = code.split("\n").filter((line) => line.trim() !== "");
	const magicLines = lines.filter((line) => hostMagicOf(language, line) !== undefined);
	if (magicLines.length === 0) return undefined;
	const first = magicLines[0] ?? "";
	const magic = hostMagicOf(language, first);
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
