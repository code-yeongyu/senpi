import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager } from "../src/tool/detached-cell-manager.ts";
import { EvalOutputCollector } from "../src/tool/image.ts";
import type { EvalToolDetails } from "../src/tool/types.ts";

const TERMINAL_SNAPSHOT_CAP = 32;
const PENDING_TOOL_CALL_CAP = 256;
const DISPLAY_IMAGE_CAP = 8;
const DISPLAY_IMAGE_BYTE_CAP = 24 * 1024 * 1024;
const JSON_OUTPUT_CAP = 64;

function managerResult(index: number): AgentToolResult<EvalToolDetails> {
	return {
		content: [{ type: "text", text: `output-${index}` }],
		details: {
			language: "js",
			languages: ["js"],
			summary: `cell ${index}`,
			durationMs: 1,
			toolCalls: [],
			truncated: false,
			cells: [
				{
					index: 0,
					summary: `cell ${index}`,
					code: String(index),
					language: "js",
					output: `output-${index}`,
					status: "complete",
					durationMs: 1,
				},
			],
		},
	};
}

describe("detached cell registry retention", () => {
	it("evicts settled cells beyond the terminal snapshot cap and keeps the newest", async () => {
		const manager = new EvalDetachedCellManager();
		const total = TERMINAL_SNAPSHOT_CAP + 8;
		for (let i = 0; i < total; i++) {
			const cell = manager.create(`cell-${i}`, { language: "js", code: String(i), summary: `cell ${i}` });
			manager.markRunning(cell);
			manager.complete(cell, managerResult(i));
		}

		const oldestEvicted = total - TERMINAL_SNAPSHOT_CAP;
		expect(() => manager.peek(`cell-${oldestEvicted - 1}`)).toThrow(/Unknown detached eval cell/);
		await expect(manager.waitForTerminal(`cell-${oldestEvicted - 1}`)).rejects.toThrow(/Unknown detached eval cell/);

		const retained = manager.peek(`cell-${oldestEvicted}`);
		expect(retained.cellId).toBe(`cell-${oldestEvicted}`);
		expect(retained.state).toBe("completed");

		const newest = manager.peek(`cell-${total - 1}`);
		expect(newest.cellId).toBe(`cell-${total - 1}`);
		await expect(manager.waitForTerminal(`cell-${total - 1}`)).resolves.toMatchObject({
			cellId: `cell-${total - 1}`,
			state: "completed",
		});
		await expect(manager.stop(`cell-${total - 1}`)).resolves.toMatchObject({
			cellId: `cell-${total - 1}`,
			state: "completed",
		});
	});

	it("reuses a cell id after its settled entry was evicted", () => {
		const manager = new EvalDetachedCellManager();
		const total = TERMINAL_SNAPSHOT_CAP + 8;
		for (let i = 0; i < total; i++) {
			const cell = manager.create(`cell-${i}`, { language: "js", code: String(i), summary: `cell ${i}` });
			manager.markRunning(cell);
			manager.complete(cell, managerResult(i));
		}
		const recreated = manager.create("cell-0", { language: "js", code: "return 1", summary: "recreated" });
		manager.markRunning(recreated);
		manager.complete(recreated, managerResult(999));
		expect(manager.peek("cell-0").state).toBe("completed");
	});
});

describe("JavaScriptKernel pending tool-call retention", () => {
	it("bounds queued tool calls and reports the dropped count", async () => {
		const seen: KernelToHostMessage[] = [];
		const kernel = new JavaScriptKernel({
			sessionId: "tool-call-flood",
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			onMessage: (message) => seen.push(message),
		});
		try {
			const flood = PENDING_TOOL_CALL_CAP + 44;
			const run = kernel.run({
				cellId: "flood-cell",
				code: `return await Promise.allSettled([...Array(${flood})].map((_, i) => tool.read({ path: "f-" + i })))`,
				timeoutMs: 30_000,
			});
			const deadline = Date.now() + 20_000;
			while (seen.filter((message) => message.type === "tool-call").length < flood) {
				if (Date.now() > deadline) throw new Error("timed out waiting for the tool-call flood");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			for (let i = 0; i < PENDING_TOOL_CALL_CAP; i++) await kernel.nextToolCall();
			const extra = await Promise.race([
				kernel.nextToolCall().then(() => "call" as const),
				new Promise<"empty">((resolve) => setTimeout(() => resolve("empty"), 300)),
			]);
			expect(extra).toBe("empty");

			await kernel.interrupt("retention test done");
			await run.catch(() => undefined);
		} finally {
			await kernel.close();
		}
	}, 60_000);

	it("clears queued tool calls when the active run is interrupted", async () => {
		const seen: KernelToHostMessage[] = [];
		const kernel = new JavaScriptKernel({
			sessionId: "tool-call-clear",
			cwd: process.cwd(),
			parallelPoolWidth: 2,
			onMessage: (message) => seen.push(message),
		});
		try {
			const run = kernel.run({
				cellId: "clear-cell",
				code: `return await Promise.allSettled([...Array(5)].map((_, i) => tool.read({ path: "c-" + i })))`,
				timeoutMs: 15_000,
			});
			const deadline = Date.now() + 15_000;
			while (seen.filter((message) => message.type === "tool-call").length < 5) {
				if (Date.now() > deadline) throw new Error("timed out waiting for tool calls");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			await kernel.interrupt("clear pending tool calls");
			await run.catch(() => undefined);

			const leftover = await Promise.race([
				kernel.nextToolCall().then(() => "call" as const),
				new Promise<"empty">((resolve) => setTimeout(() => resolve("empty"), 300)),
			]);
			expect(leftover).toBe("empty");
		} finally {
			await kernel.close();
		}
	}, 30_000);
});

describe("per-cell display buffer bounds", () => {
	const PNG_1X1_BASE64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

	function makeCollector() {
		return new EvalOutputCollector({
			headBytes: 1_000_000,
			maxColumns: 120,
			model: undefined,
			imageResizer: async (image) => ({ image }),
			onChunk: () => undefined,
		});
	}

	it("caps retained display images per cell", async () => {
		const collector = makeCollector();
		for (let i = 0; i < DISPLAY_IMAGE_CAP + 4; i++) {
			collector.display({ type: "display", mimeType: "image/png", dataBase64: PNG_1X1_BASE64 });
		}
		const result = await collector.finish();
		expect(result.images.length).toBeLessThanOrEqual(DISPLAY_IMAGE_CAP);
	});

	it("caps retained display image bytes per cell", async () => {
		const collector = makeCollector();
		const payloadChars = Math.ceil(DISPLAY_IMAGE_BYTE_CAP / 2) + 4;
		const bigPayload = Buffer.alloc(Math.ceil((payloadChars * 3) / 4), 0x42).toString("base64");
		collector.display({ type: "display", mimeType: "image/png", dataBase64: bigPayload });
		collector.display({ type: "display", mimeType: "image/png", dataBase64: bigPayload });
		const result = await collector.finish();
		const retainedBytes = result.images.reduce((sum, image) => sum + image.data.length, 0);
		expect(retainedBytes).toBeLessThanOrEqual(DISPLAY_IMAGE_BYTE_CAP);
	});

	it("caps retained JSON display outputs per cell", async () => {
		const collector = makeCollector();
		for (let i = 0; i < JSON_OUTPUT_CAP + 12; i++) {
			const dataBase64 = Buffer.from(JSON.stringify({ index: i }), "utf8").toString("base64");
			collector.display({ type: "display", mimeType: "application/json", dataBase64 });
		}
		const result = await collector.finish();
		expect(result.jsonOutputs.length).toBeLessThanOrEqual(JSON_OUTPUT_CAP);
	});
});
