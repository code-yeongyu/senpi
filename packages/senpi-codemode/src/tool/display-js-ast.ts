import { parse } from "@babel/parser";

export type SourceNode = {
	readonly type: string;
	readonly start: number;
	readonly end: number;
	readonly record: Readonly<Record<string, unknown>>;
};

export type Edit = { readonly start: number; readonly end: number; readonly text: string };

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function sourceNode(value: unknown): SourceNode | undefined {
	if (!isRecord(value)) return undefined;
	const { type, start, end } = value;
	if (typeof type !== "string" || typeof start !== "number" || typeof end !== "number") return undefined;
	return { type, start, end, record: value };
}

export function sourceNodes(value: unknown): SourceNode[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => sourceNode(item) ?? []);
}

export function childNodes(node: SourceNode): SourceNode[] {
	return Object.entries(node.record).flatMap(([key, value]) => {
		if (key === "loc" || key === "extra" || key.endsWith("Comments")) return [];
		return Array.isArray(value) ? sourceNodes(value) : (sourceNode(value) ?? []);
	});
}

/** Parses a cell the way the js kernel accepts it: module syntax, top-level `await` and `return`. */
export function parseFile(code: string): SourceNode | undefined {
	try {
		return sourceNode(
			parse(code, {
				sourceType: "module",
				allowAwaitOutsideFunction: true,
				allowReturnOutsideFunction: true,
				allowImportExportEverywhere: true,
			}),
		);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export function programOf(file: SourceNode | undefined): SourceNode | undefined {
	return file === undefined ? undefined : sourceNode(file.record.program);
}

export function applyEdits(code: string, edits: readonly Edit[]): string {
	const sorted = [...edits].sort((left, right) => left.start - right.start);
	let output = "";
	let cursor = 0;
	for (const edit of sorted) {
		output += code.slice(cursor, edit.start) + edit.text;
		cursor = edit.end;
	}
	return output + code.slice(cursor);
}
