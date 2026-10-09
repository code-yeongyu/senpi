import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../../agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../../../agent/src/harness/env/nodejs.ts";
import { createEditTool as createHarnessEdit } from "../../../agent/src/harness/tools/edit.ts";
import { createReadTool as createHarnessRead } from "../../../agent/src/harness/tools/read.ts";
import { type ReadFolder, selectedReadFolder } from "../../../agent/src/harness/utils/read-folders/index.ts";
import { createEditTool } from "../../src/core/tools/edit.ts";
import { createReadTool, type ReadToolInput } from "../../src/core/tools/read.ts";

export const invocation = {
	invocationId: "read-summary",
	operationId: "read-summary",
	turnId: "read-summary",
	getMemo: async () => undefined,
	setMemo: async () => {
		throw new Error("Read must not memoize");
	},
};
export const readerNames = ["coding-agent", "harness"] as const;
export type ReaderName = (typeof readerNames)[number];
export const interiorFolder: ReadFolder = Object.freeze({
	id: "test-interior",
	version: "1",
	fold: ({ text }) => ({
		status: "parsed",
		text,
		ranges: [{ startLine: 51, endLine: text.split("\n").length - 1, children: [] }],
	}),
} satisfies ReadFolder);
export function textOutput(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}
export function jsonSource(): string {
	return JSON.stringify(
		Array.from({ length: 20 }, (_, n) => Array.from({ length: 12 }, (_, i) => `body-${n}-${i} brace } {`)),
		null,
		2,
	);
}
export function source(total = 160): string {
	const body = (n: number) =>
		[
			`function f${n}() {`,
			...Array.from({ length: 6 }, (_, i) => `  const x${i} = "body-${n}-${i} brace } {";`),
			"}",
		].join("\n");
	const count = Math.floor(total / 8);
	return [
		...Array.from({ length: count }, (_, i) => body(i)),
		...Array.from({ length: total % 8 }, (_, i) => `const top${i} = ${i};`),
	].join("\n");
}
export function readers(cwd: string, options: { folder?: ReadFolder } = { folder: selectedReadFolder }) {
	const coding = createReadTool(cwd, options);
	const harness = createHarnessRead(options);
	const env = new NodeExecutionEnv({ cwd });
	return {
		coding,
		harness,
		read(name: ReaderName, input: ReadToolInput, signal?: AbortSignal) {
			switch (name) {
				case "coding-agent":
					return coding.execute("read", input, signal);
				case "harness":
					return harness.execute(
						"read",
						input,
						() => {},
						{ env },
						invocation,
						signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
					);
				default:
					return name satisfies never;
			}
		},
		async edit(name: ReaderName, input: { path: string; edits: { oldText: string; newText: string }[] }) {
			switch (name) {
				case "coding-agent":
					return createEditTool(cwd).execute("edit", input);
				case "harness":
					return createHarnessEdit().execute("edit", input, () => {}, { env }, invocation, BACKGROUND_CONTEXT);
				default:
					return name satisfies never;
			}
		},
	};
}
export async function privateDir<T>(run: (cwd: string) => Promise<T>): Promise<T> {
	const cwd = await mkdtemp(join(tmpdir(), "read-summary-"));
	try {
		return await run(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}
export function rereads(output: string) {
	return [...output.matchAll(/offset=(\d+) limit=(\d+)/g)].map((match) => ({
		offset: Number(match[1]),
		limit: Number(match[2]),
	}));
}
export function assertSummary(output: string) {
	assert(output.split("\n").includes("\u2026"));
	const ranges = rereads(output);
	assert(ranges.length > 0);
	return ranges;
}
