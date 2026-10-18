import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { EvalNotifier } from "../src/extension/eval-notifier.ts";
import type { EvalDetachedCellSnapshot } from "../src/tool/detached-cell-manager.ts";
import { buildDetachedCellNotification } from "../src/tool/detached-cell-notification.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

function completedSnapshot(
	text: string,
	images: readonly { readonly data: string; readonly mimeType: string }[] = [],
): EvalDetachedCellSnapshot {
	return {
		cellId: "budget-cell",
		language: "js",
		startedAtMs: 0,
		state: "completed",
		outputTail: "",
		stateRetained: undefined,
		result: {
			content: [{ type: "text", text }, ...images.map((image) => ({ type: "image" as const, ...image }))],
			details: { language: "js", durationMs: 0, toolCalls: [], truncated: false },
		},
	};
}

function fakeModel(): Model<Api> {
	return {
		id: "test",
		name: "test",
		api: "fake-api",
		provider: "fake",
		baseUrl: "https://fake.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

function numberedLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, index) => `line ${String(index + 1).padStart(5, "0")} ${"x".repeat(60)}`,
	).join("\n");
}

describe("detached cell notification parity with the foreground result", () => {
	it("Given a detached cell whose output is a few kilobytes when it completes then the notification carries all of it", () => {
		const output = numberedLines(80);
		expect(Buffer.byteLength(output)).toBeGreaterThan(4_000);

		const notification = buildDetachedCellNotification(completedSnapshot(output));

		expect(notification.content).toContain(output);
		expect(notification.content).not.toMatch(/capped|elided|overflowed/u);
	});

	it("Given a detached cell that returned one long line of JSON when it completes then the notification carries all of it", () => {
		const output = JSON.stringify({
			rows: Array.from({ length: 800 }, (_, index) => ({ index, label: `row-${index}` })),
		});
		expect(Buffer.byteLength(output)).toBeGreaterThan(20_000);
		expect(output).not.toContain("\n");

		const notification = buildDetachedCellNotification(completedSnapshot(output));

		expect(notification.content).toContain(output);
	});

	it("Given a detached cell whose result the output sink bounded when it completes then the notification shows exactly the foreground text, marker and artifact notice included", () => {
		const foregroundText = [
			numberedLines(40),
			"[…3920ln elided…]",
			numberedLines(40),
			"Full output: /tmp/senpi-artifacts/eval-1.log",
		].join("\n");

		const notification = buildDetachedCellNotification(completedSnapshot(foregroundText));

		expect(notification.content).toContain(foregroundText);
	});

	it("Given a large notification when it is built then the outcome line and the kernel-state note frame the output", () => {
		const notification = buildDetachedCellNotification(completedSnapshot(numberedLines(1_000)));

		expect(notification.content.startsWith("<system-reminder>Detached eval cell budget-cell (js) completed.")).toBe(
			true,
		);
		expect(notification.content).toMatch(
			/Kernel state updated - variables are available to the next eval cell\.<\/system-reminder>$/u,
		);
	});

	it("Given a detached cell that displayed an image when it completes then the notification delivers the image", () => {
		const sent: unknown[] = [];
		const notifier = new EvalNotifier({
			sendMessage: (message) => sent.push(message.content),
			getContext: () => ({ ...fakeExtensionContext(), mode: "tui" as const, model: fakeModel() }),
			getMode: () => "wake",
		});
		const notification = buildDetachedCellNotification(
			completedSnapshot("drew a chart", [{ data: "iVBORw0KGgo=", mimeType: "image/png" }]),
		);

		notifier.notify([notification]);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual([
			{ type: "text", text: expect.stringContaining("drew a chart") },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
	});
});
