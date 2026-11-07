import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedTerminalSession, TerminalManager } from "../../../src/core/extensions/builtin/terminal/manager.ts";
import { createPtyBashTool } from "../../../src/core/extensions/builtin/terminal/tools/bash.ts";
import type { TerminalToolContext } from "../../../src/core/extensions/builtin/terminal/tools/context.ts";

/**
 * senpi#6189: a bash call arms its kill timer and detach gate only after spawn returns, so a spawn that never
 * returns used to leave no trace at all. It is now logged once at the stall threshold, and only then.
 */

interface Warning {
	readonly event: string;
	readonly data: Record<string, unknown> | undefined;
}

function contextWith(create: () => Promise<CreatedTerminalSession>, warnings: Warning[]): TerminalToolContext {
	const manager = { create, stop: async () => {} } as unknown as TerminalManager;
	return {
		manager,
		cwd: tmpdir(),
		defaultCols: 80,
		defaultRows: 24,
		timeoutAction: "kill",
		getEnv: () => ({}),
		sessionLogger: { warn: (event, data) => warnings.push({ event, data }) },
	};
}

function exitedSession(): CreatedTerminalSession {
	const runtime = {
		exited: true,
		exitResult: { exitCode: 0, signal: null, cancelled: false, timedOut: false },
		fullOutput: () => "ok",
		session: { waitExit: () => Promise.resolve(), kill: () => {}, onExit: () => () => {} },
	};
	return { id: "bash_1", runtime } as unknown as CreatedTerminalSession;
}

describe("#6189 bash reports a spawn that outlives its stall threshold", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("logs bash_spawn_stalled once when the spawn never returns", () => {
		const warnings: Warning[] = [];
		const tool = createPtyBashTool(contextWith(() => new Promise<never>(() => {}), warnings));

		// given a bash call whose spawn never settles
		void tool.execute("call_stalled", { command: "true", timeout: 120 });

		// when the clock reaches the 30 s threshold (the call's 120 s timeout is longer)
		vi.advanceTimersByTime(29_999);
		expect(warnings).toEqual([]);
		vi.advanceTimersByTime(1);

		// then exactly one warning names the call
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.event).toBe("bash_spawn_stalled");
		expect(warnings[0]?.data).toMatchObject({ toolCallId: "call_stalled", toolName: "bash", thresholdMs: 30_000 });
		vi.advanceTimersByTime(60_000);
		expect(warnings).toHaveLength(1);
	});

	it("logs nothing when the spawn returns", async () => {
		const warnings: Warning[] = [];
		const tool = createPtyBashTool(contextWith(() => Promise.resolve(exitedSession()), warnings));

		// given a bash call whose spawn returns at once
		const result = await tool.execute("call_ok", { command: "true", timeout: 120 });

		// when the clock runs well past the threshold
		vi.advanceTimersByTime(120_000);

		// then the call completed and nothing was logged
		expect(result.content.map((part) => part.text).join("")).toContain("ok");
		expect(warnings).toEqual([]);
	});
});
