import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

function result(cellId: string): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: cellId }],
		details: {
			language: "js",
			languages: ["js"],
			summary: cellId,
			durationMs: 1,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					summary: cellId,
					code: "1",
					language: "js",
					output: cellId,
					status: "complete",
					durationMs: 1,
				},
			],
		},
	};
}

function managerWith(settled: readonly string[], live: readonly string[] = []): EvalDetachedCellManager {
	const manager = new EvalDetachedCellManager();
	for (const cellId of settled) {
		const cell = manager.create(cellId, { language: "js", code: "1", summary: cellId });
		manager.markRunning(cell);
		manager.complete(cell, result(cellId));
	}
	for (const cellId of live) {
		manager.markRunning(manager.create(cellId, { language: "js", code: "1", summary: cellId }));
	}
	return manager;
}

describe("unknown detached cell id suggests the one close known id", () => {
	it("names the settled cell one edit away", () => {
		const manager = managerWith(["toolu_01AbCdEfGh", "toolu_01ZzYyXxWw"]);

		expect(() => manager.peek("toolu_01AbCdEfG")).toThrow(
			'Unknown detached eval cell "toolu_01AbCdEfG"; did you mean "toolu_01AbCdEfGh"?',
		);
	});

	it("names a live cell when stopping a mistyped id", async () => {
		const manager = managerWith([], ["toolu_01LiveCell"]);

		await expect(manager.stop("toolu_01LivCell")).rejects.toThrow('did you mean "toolu_01LiveCell"?');
	});

	it("suggests nothing when no known id is close", () => {
		const manager = managerWith(["toolu_01AbCdEfGh"]);

		expect(() => manager.peek("something-else")).toThrow(/^Unknown detached eval cell "something-else"$/);
	});

	it("suggests nothing when two known ids are equally close", () => {
		const manager = managerWith(["cell-1", "cell-2"]);

		expect(() => manager.peek("cell-3")).toThrow(/^Unknown detached eval cell "cell-3"$/);
	});
});
