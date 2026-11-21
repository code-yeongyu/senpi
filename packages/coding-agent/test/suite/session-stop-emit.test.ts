import { afterEach, expect, it, vi } from "vitest";
import { runSessionStopHandlers } from "../../src/core/extensions/session-stop-emit.ts";

// oh-my-openagent#14390 with the #14354 lesson: a stop never hangs on one owner.

afterEach(() => {
	vi.useRealTimers();
});

it("reports an owner that never answers, or throws, under failed and still runs every later owner", async () => {
	vi.useFakeTimers();
	const reached: string[] = [];
	const stopping = runSessionStopHandlers(
		[
			{ extensionPath: "<test:hung>", call: () => new Promise(() => {}) },
			{
				extensionPath: "<test:throws>",
				call: () => {
					throw new Error("child store is locked");
				},
			},
			{ extensionPath: "<test:nothing>", call: () => undefined },
			{
				extensionPath: "<test:answers>",
				call: () => {
					reached.push("answers");
					return { stopped: [{ kind: "child", id: "c1" }], failed: [] };
				},
			},
		],
		{ warnMs: 0, timeoutMs: 1_000 },
	);
	await vi.advanceTimersByTimeAsync(1_000);
	const report = await stopping;
	expect(reached).toEqual(["answers"]);
	expect(report.owners.map((owner) => [owner.extensionPath, owner.stopped.length, owner.failed.length])).toEqual([
		["<test:hung>", 0, 1],
		["<test:throws>", 0, 1],
		["<test:answers>", 1, 0],
	]);
	expect(report.owners[1]?.failed[0]?.reason).toBe("child store is locked");
});
