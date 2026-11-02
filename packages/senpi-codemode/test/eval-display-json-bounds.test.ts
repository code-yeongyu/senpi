import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { RenderEnvironment } from "../src/tool/render-blocks.ts";
import { renderJsonOutputs } from "../src/tool/render-detail.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";
import { plainTheme } from "./eval-render-fixtures.ts";

type ToolContent = AgentToolResult<unknown>["content"][number];
function textOf(toolResult: AgentToolResult<unknown>): string {
	return toolResult.content.flatMap((part: ToolContent) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function createTool(kernel: FakeKernel) {
	return createEvalTool({
		enabledLanguages: { py: false, js: true, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
}

function renderEnvironment(expanded: boolean): RenderEnvironment {
	return { expanded, theme: plainTheme(), spinnerFrame: undefined, width: 80, meta: undefined, now: 0 };
}

describe("eval display jsonOutputs bounds (#3261)", () => {
	it("Given a displayed object wrapping a large Buffer when the cell settles then the stored jsonOutputs entry is bounded", async () => {
		// Given: the exact payload the JS kernel emits for display({ buffer, width, height }):
		// Buffer#toJSON explodes the bytes into one number per byte.
		const value = { buffer: Buffer.alloc(3_000_000), width: 1, height: 1 };
		const kernel = new FakeKernel([
			{
				type: "display",
				mimeType: "application/json",
				dataBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
			},
			result("bounded-display", "done"),
		]);

		// When
		const toolResult = await createTool(kernel).execute(
			"bounded-display",
			{ language: "js", code: "display(shot)", summary: "bounded display" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then: the stored entry keeps the metadata, replaces the bytes with a placeholder,
		// and stays within the same order of budget as the model-facing text.
		const stored = toolResult.details.jsonOutputs;
		expect(stored).toHaveLength(1);
		if (stored === undefined) throw new Error("jsonOutputs missing from eval result details");
		expect(stored[0]).toEqual({ buffer: "<Buffer 2.9 MB>", width: 1, height: 1 });
		expect(JSON.stringify(stored[0]).length).toBeLessThan(16_000);
		// And the model-facing text still renders the capped JSON tree.
		expect(textOf(toolResult)).toContain("display[1]:");
	});

	it("Given a legacy oversized stored Buffer entry when rendered then a bounded placeholder line is shown", () => {
		// Given: an entry as stored by sessions before the storage bound existed.
		const legacy = { type: "Buffer", data: new Array(3_000_000).fill(0), width: 1, height: 1 };

		// When
		const collapsed = renderJsonOutputs([legacy], renderEnvironment(false));
		const expanded = renderJsonOutputs([legacy], renderEnvironment(true));

		// Then
		expect(collapsed.join("\n")).toContain("<Buffer 2.9 MB>");
		expect(collapsed.length).toBeLessThanOrEqual(4);
		expect(expanded.join("\n")).toContain("<Buffer 2.9 MB>");
		expect(expanded.length).toBeLessThanOrEqual(4);
	});

	it("Given the real legacy shape with the Buffer nested under a key when rendered then the placeholder shows for the buffer key", () => {
		// Given: the shape sessions actually hold, {buffer:{type:"Buffer",data},width,height}.
		const legacy = { buffer: { type: "Buffer", data: new Array(3_000_000).fill(0) }, width: 1, height: 1 };

		// When
		const collapsed = renderJsonOutputs([legacy], renderEnvironment(false));
		const expanded = renderJsonOutputs([legacy], renderEnvironment(true));

		// Then: the buffer key collapses to the placeholder and the sibling keys stay visible.
		const collapsedText = collapsed.join("\n");
		expect(collapsedText).toContain("<Buffer 2.9 MB>");
		expect(collapsedText).toContain("width");
		expect(collapsedText).toContain("height");
		expect(collapsedText).not.toContain("[0]:");
		const expandedText = expanded.join("\n");
		expect(expandedText).toContain("<Buffer 2.9 MB>");
		expect(expandedText).toContain("width");
		expect(expandedText).not.toContain("[0]:");
		expect(expanded.length).toBeLessThanOrEqual(8);
	});

	it("Given a legacy oversized stored entry when rendered then a bounded summary replaces the tree", () => {
		// Given: a stored entry far beyond the display text budget with no Buffer shape.
		const legacy = { payload: "x".repeat(200_000) };

		// When
		const lines = renderJsonOutputs([legacy], renderEnvironment(true));

		// Then
		expect(lines.join("\n")).toContain("oversized");
		expect(lines.length).toBeLessThanOrEqual(4);
	});

	it("Given a malformed stored entry when rendered then the failure stays local to the entry", () => {
		// Given: an entry whose key enumeration throws.
		const malformed = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("boom");
				},
				getOwnPropertyDescriptor() {
					throw new Error("boom");
				},
			},
		);

		// When / Then: one bad entry must not take down the component, and good entries still render.
		let lines: string[] = [];
		expect(() => {
			lines = renderJsonOutputs([malformed, { ok: 1 }], renderEnvironment(false));
		}).not.toThrow();
		expect(lines.join("\n")).toContain("could not be rendered");
		expect(lines.join("\n")).toContain("ok");
	});

	describe("stored entries keep every top-level shape under the budget (#3261 review)", () => {
		async function storeDisplay(value: unknown): Promise<unknown> {
			const kernel = new FakeKernel([
				{
					type: "display",
					mimeType: "application/json",
					dataBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
				},
				result("bounded-shape", "done"),
			]);
			const toolResult = await createTool(kernel).execute(
				"bounded-shape",
				{ language: "js", code: "display(value)", summary: "bounded shape" },
				undefined,
				undefined,
				fakeExtensionContext(),
			);
			const stored = toolResult.details.jsonOutputs;
			if (stored === undefined || stored.length !== 1)
				throw new Error("expected exactly one stored jsonOutputs entry");
			return stored[0];
		}

		const BUDGET = 8_000;

		it("a long array of records stays a non-empty partial array with an elision marker", async () => {
			// Given: ~300 records whose full serialization is ~21 KB.
			const records = Array.from({ length: 300 }, (_, index) => ({
				id: index,
				name: `user-${index}`,
				email: `user-${index}@example.com`,
				active: index % 2 === 0,
			}));

			// When
			const stored = await storeDisplay(records);

			// Then: an array that kept a non-empty prefix, visibly marked, inside the budget.
			expect(Array.isArray(stored)).toBe(true);
			if (!Array.isArray(stored)) return;
			expect(stored.length).toBeGreaterThanOrEqual(2);
			expect(stored[0]).toEqual({ id: 0, name: "user-0", email: "user-0@example.com", active: true });
			const last = stored[stored.length - 1];
			expect(typeof last).toBe("string");
			expect(String(last)).toContain("more items");
			expect(stored.length - 1).toBeLessThan(records.length);
			expect(JSON.stringify(stored).length).toBeLessThanOrEqual(BUDGET);
		});

		it("a wide object keeps its leading keys with an elision marker, not a dropped value", async () => {
			// Given: 500 keys of 500-char values (~260 KB serialized).
			const wide: Record<string, string> = {};
			for (let index = 0; index < 500; index += 1) wide[`key-${String(index).padStart(4, "0")}`] = "v".repeat(500);

			// When
			const stored = await storeDisplay(wide);

			// Then: a record, not the whole-value elision string.
			expect(typeof stored).toBe("object");
			expect(stored === null || Array.isArray(stored)).toBe(false);
			if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return;
			const record = stored as Record<string, unknown>;
			expect(record["key-0000"]).toMatch(/^v+\[…\d+ch elided…\]$/);
			expect(Object.keys(record).length).toBeGreaterThan(10);
			expect(Object.values(record).some((value) => typeof value === "string" && value.includes("more keys"))).toBe(
				true,
			);
			expect(JSON.stringify(stored).length).toBeLessThanOrEqual(BUDGET);
		});

		it("a long string under a key truncates with a marker and keeps its sibling keys", async () => {
			// Given
			const value = { payload: "x".repeat(200_000), width: 1, height: 1 };

			// When
			const stored = await storeDisplay(value);

			// Then
			if (typeof stored !== "object" || stored === null || Array.isArray(stored))
				throw new Error("expected a record");
			const record = stored as Record<string, unknown>;
			expect(record.width).toBe(1);
			expect(record.height).toBe(1);
			expect(typeof record.payload).toBe("string");
			expect(String(record.payload)).toContain("elided");
			expect(JSON.stringify(stored).length).toBeLessThanOrEqual(BUDGET);
		});

		it("a control-character string keeps its sibling keys and stays inside the budget", async () => {
			// Given: 1,900 chars that each escape to six characters (~11.4 KB serialized).
			const value = { control: "\u0001".repeat(1_900), width: 1, height: 1 };

			// When
			const stored = await storeDisplay(value);

			// Then: the sibling keys survive and the escaped serialization fits the budget.
			if (typeof stored !== "object" || stored === null || Array.isArray(stored))
				throw new Error("expected a record");
			const record = stored as Record<string, unknown>;
			expect(record.width).toBe(1);
			expect(record.height).toBe(1);
			expect(typeof record.control).toBe("string");
			expect(String(record.control)).toContain("elided");
			expect(JSON.stringify(stored).length).toBeLessThanOrEqual(BUDGET);
		});

		it("a deeply nested value keeps its top-level keys with a depth marker", async () => {
			// Given: 40 levels of nesting.
			let node: unknown = { leaf: "value" };
			for (let index = 0; index < 40; index += 1) node = { child: node, level: index };

			// When
			const stored = await storeDisplay({ root: node, width: 1 });

			// Then
			if (typeof stored !== "object" || stored === null || Array.isArray(stored))
				throw new Error("expected a record");
			const record = stored as Record<string, unknown>;
			expect(record.width).toBe(1);
			expect("root" in record).toBe(true);
			expect(JSON.stringify(stored)).toContain("\u2026");
			expect(JSON.stringify(stored).length).toBeLessThanOrEqual(BUDGET);
		});

		it("a Buffer nested under a key becomes a placeholder summary with its sibling keys", async () => {
			// Given
			const value = { buffer: Buffer.alloc(3_000_000), width: 1, height: 1 };

			// When
			const stored = await storeDisplay(value);

			// Then
			if (typeof stored !== "object" || stored === null || Array.isArray(stored))
				throw new Error("expected a record");
			const record = stored as Record<string, unknown>;
			expect(record.buffer).toBe("<Buffer 2.9 MB>");
			expect(record.width).toBe(1);
			expect(record.height).toBe(1);
			expect(JSON.stringify(stored).length).toBeLessThanOrEqual(BUDGET);
		});
	});
});

describe("eval display wrapped image detection (#3261)", () => {
	async function displayEvents(code: string): Promise<KernelToHostMessage[]> {
		const kernel = new JavaScriptKernel({
			sessionId: "wrapped-buffer-detection",
			cwd: process.cwd(),
			parallelPoolWidth: 1,
			onMessage: () => {},
		});
		const messages: KernelToHostMessage[] = [];
		try {
			await kernel.run({
				cellId: `cell-${crypto.randomUUID()}`,
				code,
				timeoutMs: 5_000,
				onMessage: (message) => messages.push(message),
			});
		} finally {
			await kernel.close();
		}
		return messages.filter((message) => message.type === "display" || message.type === "text");
	}

	it("Given an object whose buffer field holds image bytes when displayed then it resolves to an image frame plus metadata text", async () => {
		// Given: the omowright screenshot shape { buffer, width, height }.
		const events = await displayEvents(
			"display({ buffer: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]), width: 2, height: 3 })",
		);

		// Then: the metadata displays as compact JSON stdout text, then the bytes as an image frame.
		expect(events).toEqual([
			{ type: "text", stream: "stdout", data: `${JSON.stringify({ width: 2, height: 3 })}\n` },
			{
				type: "display",
				mimeType: "image/png",
				dataBase64: Buffer.from(
					new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
				).toString("base64"),
			},
		]);
	});

	it("Given an object whose buffer field holds non-image bytes when displayed then it stays on the JSON path", async () => {
		const events = await displayEvents("display({ buffer: new Uint8Array([65,66,67]), note: 'abc' })");

		// Then: one JSON display carrying the serialized bytes, no image frame.
		expect(events).toHaveLength(1);
		const display = events[0];
		expect(display.type).toBe("display");
		if (display.type !== "display") return;
		expect(display.mimeType).toBe("application/json");
		expect(JSON.parse(Buffer.from(display.dataBase64, "base64").toString("utf8"))).toEqual({
			buffer: { 0: 65, 1: 66, 2: 67 },
			note: "abc",
		});
	});

	it("Given an object holding only image bytes under buffer when displayed then just the frame resolves", async () => {
		const events = await displayEvents(
			"display({ buffer: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]) })",
		);

		// Then
		expect(events).toEqual([
			{
				type: "display",
				mimeType: "image/png",
				dataBase64: Buffer.from(
					new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
				).toString("base64"),
			},
		]);
	});

	it("Given an object whose buffer field holds BM-prefixed non-BMP bytes when displayed then it stays on the JSON path", async () => {
		// Given: text bytes that start with 'BM' but are not a plausible BMP header.
		const events = await displayEvents(
			"display({ buffer: new TextEncoder().encode('BMx this is plain text, not a bitmap'), width: 1 })",
		);

		// Then: no image frame; the value stays on the JSON path.
		expect(events).toHaveLength(1);
		const display = events[0];
		expect(display.type).toBe("display");
		if (display.type !== "display") return;
		expect(display.mimeType).toBe("application/json");
	});
});
