import { readFile } from "fs/promises";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { createUnifiedPatch } from "./unified-diff.ts";

export type WriteToolDetails = {
	readonly operation: "add" | "update";
	readonly patch: string;
};

export type WriteBaseline =
	| { readonly kind: "missing" }
	| { readonly kind: "present"; readonly content: string }
	| { readonly kind: "unavailable" };

export async function readLocalWriteBaseline(absolutePath: string): Promise<WriteBaseline> {
	try {
		return { kind: "present", content: await readFile(absolutePath, "utf-8") };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
		if (error instanceof Error) return { kind: "unavailable" };
		throw error;
	}
}

export function createWriteDetails(
	path: string,
	content: string,
	baseline: WriteBaseline,
): WriteToolDetails | undefined {
	switch (baseline.kind) {
		case "missing":
			return { operation: "add", patch: createUnifiedPatch("/dev/null", path, "", content) };
		case "present":
			return baseline.content === content
				? undefined
				: { operation: "update", patch: createUnifiedPatch(path, path, baseline.content, content) };
		case "unavailable":
			return undefined;
		default: {
			const exhaustive: never = baseline;
			return exhaustive;
		}
	}
}

export function formatWriteResult(
	result: {
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly isError?: boolean;
	},
	theme: Theme,
): string | undefined {
	if (!result.isError) return undefined;
	const output = result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text || "")
		.join("\n");
	return output ? `\n${theme.fg("error", output)}` : undefined;
}
