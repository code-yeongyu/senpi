import type { ReadBraceScan, ReadFolderResult, ReadFoldRange, ReadLineRange } from "./types.ts";

/** Hierarchical omitted interiors from a flat scan. Ambiguous nesting is a parse failure, not a guess. */
export function hierarchy(ranges: readonly ReadLineRange[]): readonly ReadFoldRange[] | undefined {
	// Builder-owned arrays; no caller-owned ranges are sorted or mutated.
	type Node = ReadLineRange & { readonly children: Node[] };
	const roots: Node[] = [];
	const stack: Node[] = [];
	for (const range of [...ranges].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)) {
		while (stack.length && range.startLine > stack[stack.length - 1].endLine) stack.pop();
		const parent = stack[stack.length - 1];
		if (parent && range.startLine === parent.startLine && range.endLine === parent.endLine) continue;
		if (parent && (range.startLine <= parent.startLine || range.endLine >= parent.endLine)) return undefined;
		const node: Node = { ...range, children: [] };
		(parent ? parent.children : roots).push(node);
		stack.push(node);
	}
	return roots;
}

/** The single scan-to-result composition shared by every fold-boundary engine. */
export function composeFoldResult(text: string, scan: ReadBraceScan): ReadFolderResult {
	switch (scan.status) {
		case "parse_failure":
			return scan;
		case "parsed": {
			const ranges = hierarchy(scan.ranges);
			return ranges
				? { status: "parsed", text, ranges }
				: { status: "parse_failure", reason: "ambiguous_line_boundaries" };
		}
		default:
			return scan satisfies never;
	}
}
