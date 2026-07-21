import { describe, expect, it, vi } from "vitest";
import type { TerminalManager } from "../src/core/extensions/builtin/terminal/manager.ts";
import type { TerminalToolContext, TerminalToolResult } from "../src/core/extensions/builtin/terminal/tools/context.ts";

const state = vi.hoisted(() => ({ nextSessionId: 0 }));

vi.mock("../src/core/extensions/builtin/terminal/tools/spawn.ts", () => ({
	describeExit: () => "completed",
	spawnCommandSession: async () => {
		const listeners = new Set<(chunk: string) => void>();
		let output = "";
		let resolveExit!: () => void;
		const exitPromise = new Promise<void>((resolve) => {
			resolveExit = resolve;
		});
		const session = {
			emit(text: string) {
				output += text;
				for (const listener of listeners) listener(text);
			},
			exit() {
				resolveExit();
			},
		};
		setTimeout(() => {
			session.emit("\x1b[31mfirst\x1b[0m\n");
			setTimeout(() => {
				session.emit("second\n");
				session.exit();
			}, 150);
		}, 0);
		return {
			id: `session-${++state.nextSessionId}`,
			runtime: {
				session: {
					kill() {},
					waitExit: () => exitPromise,
				},
				exitResult: { exitCode: 0, timedOut: false },
				fullOutput: () => output,
				onOutput(listener: (chunk: string) => void) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		};
	},
}));

import { createPtyBashTool } from "../src/core/extensions/builtin/terminal/tools/bash.ts";

function resultText(result: TerminalToolResult): string {
	return result.content.map((block) => block.text).join("\n");
}

function waitForUpdateCount(
	count: number,
	timeoutMs: number,
): {
	resolve(): void;
	promise: Promise<void>;
} {
	let resolve!: () => void;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<void>((resolvePromise, reject) => {
		resolve = () => {
			if (timeout === undefined) return;
			clearTimeout(timeout);
			timeout = undefined;
			resolvePromise();
		};
		timeout = setTimeout(
			() => reject(new Error(`did not receive ${count} updates within ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	return { resolve, promise };
}

const ctx: TerminalToolContext = {
	manager: {} as TerminalManager,
	cwd: "/fixture",
	defaultCols: 80,
	defaultRows: 24,
	getEnv: () => ({}),
};

describe("PTY foreground bash streaming", () => {
	it("passes onUpdate through execute and streams growing filtered previews without changing the final result", async () => {
		const updates: unknown[] = [];
		const partialsReady = waitForUpdateCount(3, 5_000);
		const streamingTool = createPtyBashTool(ctx);
		const streamingResultPromise = streamingTool.execute(
			"streaming-call",
			{ command: "scripted output" },
			undefined,
			(update: unknown) => {
				updates.push(update);
				if (updates.length >= 3) partialsReady.resolve();
			},
		);

		await partialsReady.promise;
		const streamingResult = await streamingResultPromise;
		const baselineResult = await createPtyBashTool(ctx).execute("baseline-call", { command: "scripted output" });

		expect(updates[0]).toEqual({ content: [], details: undefined });
		const partialTexts = updates.slice(1).map((update) => {
			const result = update as { content: Array<{ type: string; text: string }> };
			return result.content[0]?.text ?? "";
		});
		expect(partialTexts).toHaveLength(2);
		expect(partialTexts[0]).toContain("first");
		expect(partialTexts[0]).not.toContain("\x1b[");
		expect(partialTexts[1]).toContain("second");
		expect(partialTexts[1].length).toBeGreaterThan(partialTexts[0].length);
		expect(updates[1]).toMatchObject({
			details: { progress: { activity: "running scripted output", startedAt: expect.any(Number) } },
		});
		expect(streamingResult).toEqual(baselineResult);
		expect(resultText(streamingResult)).toContain("first");
		expect(resultText(streamingResult)).toContain("second");
	});
});
