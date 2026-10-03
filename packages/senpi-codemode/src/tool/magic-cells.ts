import type { EvalLanguage } from "./types.ts";

export type MagicCell =
	| { readonly kind: "pip"; readonly args: string }
	| { readonly kind: "environment"; readonly mode: "managed" | "project" };

const HOST_MAGICS = ["pip", "environment"] as const;
type HostMagic = (typeof HOST_MAGICS)[number];

export class MagicCellError extends Error {
	readonly name = "MagicCellError";
}

function hostMagicOf(line: string): HostMagic | undefined {
	const match = /^%([A-Za-z]+)(?:\s|$)/.exec(line.trim());
	const name = match?.[1];
	return HOST_MAGICS.find((magic) => magic === name);
}

/**
 * A Python cell whose only non-blank line is `%pip ...` or `%environment ...` runs on the host instead of
 * the interpreter. Any other cell is ordinary; a cell that mixes one of these lines with code is refused,
 * because the install must finish before the code that imports from it runs.
 */
export function parseMagicCell(language: EvalLanguage, code: string): MagicCell | undefined {
	if (language !== "py") return undefined;
	const lines = code.split("\n").filter((line) => line.trim() !== "");
	const magicLines = lines.filter((line) => hostMagicOf(line) !== undefined);
	if (magicLines.length === 0) return undefined;
	const first = magicLines[0] ?? "";
	const magic = hostMagicOf(first);
	if (lines.length > 1)
		throw new MagicCellError(`put %${magic} on its own cell, then run the code that uses it in the next cell`);
	const args = first.trim().slice(`%${magic}`.length).trim();
	if (magic === "pip") return { kind: "pip", args };
	if (args === "managed" || args === "project") return { kind: "environment", mode: args };
	throw new MagicCellError("%environment takes one argument: managed or project");
}
