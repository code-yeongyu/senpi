import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

const outputGuard = vi.hoisted((): { stdout: string[] } => ({ stdout: [] }));

vi.mock("../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: vi.fn((text: string) => {
		outputGuard.stdout.push(text);
	}),
}));

const applied: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }> = {
	type: "retry_fallback_applied",
	from: "anthropic/claude-opus-4-6",
	to: "openai/gpt-4o",
	chainKey: "anthropic/claude-opus-4-6",
	reason: "billing",
};

const exhausted: Extract<AgentSessionEvent, { type: "retry_fallback_exhausted" }> = {
	type: "retry_fallback_exhausted",
	chainKey: "anthropic/claude-opus-4-6",
	lastError: "all models unavailable",
};

const reverted: Extract<AgentSessionEvent, { type: "retry_fallback_reverted" }> = {
	type: "retry_fallback_reverted",
	from: "openai/gpt-4o",
	to: "anthropic/claude-opus-4-6",
};

function createRuntimeHost(events: AgentSessionEvent[]) {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state: { messages: [] },
		extensionRunner: { hasHandlers: () => false, emit: vi.fn(async () => {}) },
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn((cb: (event: AgentSessionEvent) => void) => {
			listener = cb;
			return () => {
				listener = undefined;
			};
		}),
		prompt: vi.fn(async () => {
			for (const event of events) {
				listener?.(event);
			}
		}),
		reload: vi.fn(async () => {}),
		waitForSettledSessionWork: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	};
}

async function runWithEvents(mode: "text" | "json", events: AgentSessionEvent[]) {
	const runtimeHost = createRuntimeHost(events);
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
		mode,
		initialMessage: "hello",
	});
	return { exitCode, errorSpy, stdout: outputGuard.stdout.join("") };
}

function jsonStdout(stdout: string): unknown[] {
	const parsed: unknown[] = [];
	for (const line of stdout.split("\n")) {
		if (line.length > 0) {
			parsed.push(JSON.parse(line));
		}
	}
	return parsed;
}

afterEach(() => {
	outputGuard.stdout = [];
	vi.restoreAllMocks();
});

describe("print-mode fallback notice", () => {
	it("writes retry_fallback_applied to stderr in text mode and leaves stdout empty", async () => {
		const { exitCode, errorSpy, stdout } = await runWithEvents("text", [applied]);

		expect(exitCode).toBe(0);
		expect(errorSpy).toHaveBeenCalledWith("Model fallback: anthropic/claude-opus-4-6 -> openai/gpt-4o (billing)");
		expect(stdout).toBe("");
	});

	it("writes retry_fallback_applied to stderr in json mode and keeps the stdout JSON event", async () => {
		const { exitCode, errorSpy, stdout } = await runWithEvents("json", [applied]);

		expect(exitCode).toBe(0);
		expect(errorSpy).toHaveBeenCalledWith("Model fallback: anthropic/claude-opus-4-6 -> openai/gpt-4o (billing)");
		expect(jsonStdout(stdout)).toEqual([applied]);
		expect(stdout).not.toContain("Model fallback:");
	});

	it("writes exhausted and reverted fallback notices to stderr", async () => {
		const { errorSpy } = await runWithEvents("text", [exhausted, reverted]);

		expect(errorSpy).toHaveBeenCalledWith(
			"Model fallback exhausted: anthropic/claude-opus-4-6 (all models unavailable)",
		);
		expect(errorSpy).toHaveBeenCalledWith("Model fallback reverted: openai/gpt-4o -> anthropic/claude-opus-4-6");
	});
});
