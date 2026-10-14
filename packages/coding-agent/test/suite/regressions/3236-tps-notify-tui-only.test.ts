import { afterEach, describe, expect, it, vi } from "vitest";
import tpsExtension from "../../../src/core/extensions/builtin/tps.ts";

// senpi#3236: the tps agent_end notify is a TUI footer nicety. In RPC mode the
// same ctx.ui.notify call becomes an extension_ui_request that the desktop
// rendered as a "Work Log" row once per run, so the extension must notify only
// when ctx.mode is "tui".

type ExtensionContextLike = {
	mode: "tui" | "rpc" | "json" | "print";
	hasUI: true;
	ui: {
		notify(message: string): void;
	};
};

type Handler = (event: unknown, ctx: ExtensionContextLike) => unknown | Promise<unknown>;
type TpsExtension = (pi: { on(event: string, handler: Handler): void }) => void;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (event: string, handler: Handler) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
	};

	(tpsExtension as unknown as TpsExtension)(pi);

	return {
		async emit(event: string, payload: unknown, ctx: ExtensionContextLike) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

function createContext(notifications: string[], mode: ExtensionContextLike["mode"]): ExtensionContextLike {
	return {
		mode,
		hasUI: true,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	};
}

function createAssistantMessage(usage: {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		usage: {
			...usage,
			totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function runAgentTurn(notifications: string[], mode: ExtensionContextLike["mode"]) {
	const ctx = createContext(notifications, mode);
	const harness = createHarness();
	const message = createAssistantMessage({ input: 10, output: 100, cacheRead: 30, cacheWrite: 0 });

	await harness.emit("agent_start", { type: "agent_start" }, ctx);
	await harness.emit("message_start", { type: "message_start", message }, ctx);
	vi.advanceTimersByTime(1_000);
	await harness.emit("message_end", { type: "message_end", message }, ctx);
	await harness.emit("agent_end", { type: "agent_end", messages: [message] }, ctx);
}

describe("tps builtin extension notify gating (senpi#3236)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("still notifies exactly once in TUI mode with the unchanged message", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];

		await runAgentTurn(notifications, "tui");

		expect(notifications).toEqual(["TPS 100.0 tok/s. Cache hit 75.0%, 1.0s"]);
	});

	it.each(["rpc", "json", "print"] as const)("does not notify in %s mode", async (mode) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];

		await runAgentTurn(notifications, mode);

		expect(notifications).toEqual([]);
	});

	it("keeps the zero-output and zero-elapsed early returns in TUI mode", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const notifications: string[] = [];
		const ctx = createContext(notifications, "tui");
		const harness = createHarness();
		const zeroOutput = createAssistantMessage({
			input: 10,
			output: 0,
			cacheRead: 30,
			cacheWrite: 0,
		});
		const output = createAssistantMessage({ input: 10, output: 100, cacheRead: 30, cacheWrite: 0 });

		// output <= 0: no notify.
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("message_start", { type: "message_start", message: zeroOutput }, ctx);
		vi.advanceTimersByTime(1_000);
		await harness.emit("message_end", { type: "message_end", message: zeroOutput }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [zeroOutput] }, ctx);
		expect(notifications).toEqual([]);

		// elapsed <= 0: messages never started, so no notify.
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("agent_end", { type: "agent_end", messages: [output] }, ctx);
		expect(notifications).toEqual([]);
	});
});
