// senpi#3650 regression: one extension handler that never settles on the agent event queue froze the session.
// The turn's messages were never persisted, the session stayed streaming, and queued input was never delivered.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExtensionHandlerStall, HeldHandlerWaits } from "../../../src/core/extensions/handler-budget.ts";
import type { ExtensionAPI, ExtensionError } from "../../../src/core/extensions/types.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const HANDLER_TIMEOUT_MS = 100;
const NOTIFICATION = "senpi-monitor:notification";
const never = (): Promise<void> => new Promise<void>(() => {});

type HeldEvent = "agent_start" | "message_end" | "turn_end" | "agent_before_settle" | "agent_settled";

function withinRealTime<T>(work: Promise<T>, what: string, ms = 10_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setRealTimeout(() => reject(new Error(`still waiting for ${what} after ${ms} ms`)), ms);
		work.then(
			(value) => {
				clearRealTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearRealTimeout(timer);
				reject(error);
			},
		);
	});
}

function holdOnMonitorTurn(event: HeldEvent, capture: { api?: ExtensionAPI }) {
	return (pi: ExtensionAPI): void => {
		capture.api = pi;
		let monitorTurn = false;
		let held = false;
		pi.on("message_start", (payload) => {
			if (payload.message.role === "custom" && payload.message.customType === NOTIFICATION) monitorTurn = true;
		});
		const holdOnce = async (): Promise<void> => {
			if (held) return;
			held = true;
			await never();
		};
		if (event === "agent_start") {
			let starts = 0;
			pi.on("agent_start", async () => {
				starts += 1;
				if (starts === 2) await holdOnce();
			});
		} else if (event === "message_end") {
			pi.on("message_end", async (payload) => {
				if (payload.message.role === "custom" && payload.message.customType === NOTIFICATION) await holdOnce();
			});
		} else if (event === "turn_end") {
			pi.on("turn_end", async () => {
				if (monitorTurn) await holdOnce();
			});
		} else if (event === "agent_before_settle") {
			pi.on("agent_before_settle", async () => {
				if (monitorTurn) await holdOnce();
			});
		} else {
			pi.on("agent_settled", async () => {
				if (monitorTurn) await holdOnce();
			});
		}
	};
}

function sessionLogEvents(harness: Harness): Array<Record<string, unknown>> {
	const path = join(harness.tempDir, "agent", "logs", "session.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Resolves when the runner reports a stall at `stage`. Wraps the session's stall listener (which writes session.log
 * synchronously), so the test waits on the report itself rather than on timing.
 */
function stallStage(harness: Harness, stage: ExtensionHandlerStall["stage"]): Promise<ExtensionHandlerStall> {
	const runner = harness.getExtensionRunner();
	const forward = Reflect.get(runner, "handlerStallListener") as ((stall: ExtensionHandlerStall) => void) | undefined;
	return new Promise((resolve) => {
		Reflect.set(runner, "handlerStallListener", (stall: ExtensionHandlerStall) => {
			forward?.(stall);
			if (stall.stage === stage) resolve(stall);
		});
	});
}

function customMessageTypes(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : []));
}

describe("senpi#3650 a hung extension handler cannot freeze the session", () => {
	let harness: Harness;

	afterEach(() => {
		vi.useRealTimers();
		harness?.cleanup();
	});

	async function startHeld(event: HeldEvent, settings: Partial<Settings>) {
		const capture: { api?: ExtensionAPI } = {};
		harness = await createHarness({ settings, extensionFactories: [holdOnMonitorTurn(event, capture)] });
		const errors: ExtensionError[] = [];
		harness.getExtensionRunner().onError((error) => errors.push(error));
		harness.setResponses([
			fauxAssistantMessage([fauxText("reply 1")]),
			fauxAssistantMessage([fauxText("reply to monitor")]),
			fauxAssistantMessage([fauxText("reply to steer")]),
		]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		const api = capture.api;
		if (api === undefined) throw new Error("extension did not load");
		return { api, errors };
	}

	it.each<HeldEvent>(["agent_start", "message_end", "turn_end", "agent_before_settle", "agent_settled"])(
		"releases a %s handler that never settles, persists the turn, and delivers a queued steer once",
		async (event) => {
			// given an extension whose %s handler never settles on the turn a monitor notification starts
			const { api, errors } = await startHeld(event, {
				extensionEventHandlerWarnMs: 0,
				extensionEventHandlerTimeoutMs: HANDLER_TIMEOUT_MS,
			});

			// when the monitor notification starts a turn and the user steers while it is held
			api.sendMessage({ customType: NOTIFICATION, content: "monitor event", display: false }, { triggerTurn: true });
			const steering = harness.session.prompt("late steer", { streamingBehavior: "steer" });
			await withinRealTime(steering, "the steer to be accepted");
			await withinRealTime(harness.session.waitForIdle(), "the session to settle");
			await withinRealTime(harness.session.waitForSettledSessionWork(), "session work to settle");

			// then the host stopped waiting, said which handler held it, persisted the turn and delivered the steer once
			expect(errors.filter((error) => error.event === event).map((error) => error.error)).toEqual([
				`handler timed out after ${HANDLER_TIMEOUT_MS}ms`,
			]);
			expect(sessionLogEvents(harness)).toContainEqual(
				expect.objectContaining({ event: "extension_handler_stalled", handlerEvent: event, stage: "timeout" }),
			);
			expect(customMessageTypes(harness)).toContain(NOTIFICATION);
			expect(getAssistantTexts(harness)).toContain("reply to monitor");
			expect(getUserTexts(harness).filter((text) => text === "late steer")).toHaveLength(1);
			expect(getAssistantTexts(harness)).toContain("reply to steer");
			expect(harness.session.isStreaming).toBe(false);
		},
		30_000,
	);

	it.each<HeldEvent>(["agent_start", "turn_end", "agent_before_settle"])(
		"lets the turn deadline release a held %s handler when the handler budget is disabled, and delivers the steer once",
		async (event) => {
			// given no handler budget and a 60 s inactivity lease, and a %s handler that never settles
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
			const { api, errors } = await startHeld(event, {
				extensionEventHandlerWarnMs: 0,
				extensionEventHandlerTimeoutMs: 0,
				turn_inactivity_ms: 60_000,
				turn_max_runtime_ms: 0,
			});

			// when a monitor notification starts the held turn, the user steers into it, and the lease runs out
			api.sendMessage({ customType: NOTIFICATION, content: "monitor event", display: false }, { triggerTurn: true });
			const steering = harness.session.prompt("late steer", { streamingBehavior: "steer" });
			await vi.advanceTimersByTimeAsync(60_000);
			await vi.advanceTimersByTimeAsync(10_000);
			await vi.advanceTimersByTimeAsync(10_000);
			vi.useRealTimers();
			await withinRealTime(steering, "the steer to be accepted");
			await withinRealTime(harness.session.waitForIdle(), "the session to settle after the deadline");
			await withinRealTime(harness.session.waitForSettledSessionWork(), "session work to settle");

			// then the deadline released the held handler, settled the session, and the steer reached the model once
			expect(errors.filter((error) => error.event === event).map((error) => error.error)).toEqual([
				"handler released when the turn was stopped",
			]);
			expect(harness.session.isStreaming).toBe(false);
			expect(customMessageTypes(harness)).toContain(NOTIFICATION);
			expect(getUserTexts(harness).filter((text) => text === "late steer")).toHaveLength(1);
			const logged = sessionLogEvents(harness);
			expect(logged).toContainEqual(
				expect.objectContaining({
					event: "extension_handler_stalled",
					handlerEvent: event,
					stage: "released",
				}),
			);
			expect(logged.filter((line) => line.event === "turn_deadline_unsettled")).toEqual([]);
		},
		30_000,
	);

	it.each<[string, unknown]>([
		["-1", -1],
		["'abc'", "abc"],
	])(
		"keeps awaiting handlers in order and applies message_end results with an invalid budget setting (%s)",
		async (_label, invalid) => {
			// given an invalid hard cap and two message_end handlers: a slow one that logs, then one that rewrites the reply
			const order: string[] = [];
			harness = await createHarness({
				settings: { extensionEventHandlerTimeoutMs: invalid } as Partial<Settings>,
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.on("message_end", async (payload) => {
							if (payload.message.role !== "assistant") return;
							await Promise.resolve();
							await Promise.resolve();
							order.push("slow");
						});
						pi.on("message_end", async (payload) => {
							if (payload.message.role !== "assistant") return;
							order.push("rewrite");
							return {
								message: { ...payload.message, content: [{ type: "text" as const, text: "rewritten" }] },
							};
						});
					},
				],
			});
			const errors: ExtensionError[] = [];
			harness.getExtensionRunner().onError((error) => errors.push(error));
			harness.setResponses([fauxAssistantMessage([fauxText("orig")])]);

			// when a turn runs
			await withinRealTime(harness.session.prompt("go"), "the turn");
			await withinRealTime(harness.session.waitForIdle(), "the session to settle");

			// then the handlers ran in order, the rewrite was applied, and no handler error was reported
			expect(order).toEqual(["slow", "rewrite"]);
			expect(getAssistantTexts(harness)).toEqual(["rewritten"]);
			expect(errors).toEqual([]);
		},
		30_000,
	);

	it.each(["agent_start", "agent_before_settle"] as const)(
		"lets Esc release a held %s handler when the budget and the deadline are both disabled",
		async (handlerEvent) => {
			// given no handler budget, no turn deadline, and a handler that never settles
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
			const { api } = await startHeld(handlerEvent, {
				extensionEventHandlerWarnMs: 0,
				extensionEventHandlerTimeoutMs: 0,
				turn_inactivity_ms: 0,
				turn_max_runtime_ms: 0,
			});
			api.sendMessage({ customType: NOTIFICATION, content: "monitor event", display: false }, { triggerTurn: true });
			const steering = harness.session.prompt("late steer", { streamingBehavior: "steer" });
			await vi.advanceTimersByTimeAsync(0);

			// when the user presses Esc and the abort grace runs out
			const aborting = harness.session.abort();
			await vi.advanceTimersByTimeAsync(10_000);
			vi.useRealTimers();
			await withinRealTime(steering, "the steer to be accepted");
			await withinRealTime(aborting, "the abort to finish");
			await withinRealTime(harness.session.waitForIdle(), "the session to settle after Esc");
			await withinRealTime(harness.session.waitForSettledSessionWork(), "session work to settle");

			// then the held handler was released, the session settled, and the steer was delivered exactly once
			expect(harness.session.isStreaming).toBe(false);
			expect(getUserTexts(harness).filter((text) => text === "late steer")).toHaveLength(1);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(sessionLogEvents(harness)).toContainEqual(
				expect.objectContaining({
					event: "extension_handler_stalled",
					handlerEvent,
					stage: "released",
				}),
			);
		},
		30_000,
	);

	it("logs a handler that fails after the host stopped waiting on it", async () => {
		// given an agent_start handler that rejects 300 ms in, under a 100 ms cap
		let rejectLate!: (error: Error) => void;
		const late = new Promise<void>((_resolve, reject) => {
			rejectLate = reject;
		});
		late.catch(() => {});
		harness = await createHarness({
			settings: { extensionEventHandlerWarnMs: 0, extensionEventHandlerTimeoutMs: HANDLER_TIMEOUT_MS },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_start", () => late);
				},
			],
		});
		harness.setResponses([fauxAssistantMessage([fauxText("ok")])]);

		// when the turn moves on past the cap and the handler then fails
		await withinRealTime(harness.session.prompt("go"), "the turn");
		await withinRealTime(harness.session.waitForIdle(), "the session to settle");
		const lateFailure = stallStage(harness, "late_failure");
		rejectLate(new Error("late boom"));
		await withinRealTime(lateFailure, "the late failure to be reported");

		// then session.log records the late failure with its error
		expect(sessionLogEvents(harness)).toContainEqual(
			expect.objectContaining({
				event: "extension_handler_stalled",
				handlerEvent: "agent_start",
				stage: "late_failure",
				error: "late boom",
			}),
		);
	}, 30_000);
});

describe("senpi#3650 HeldHandlerWaits", () => {
	it("releases only the waits of the given turn", () => {
		// given waits held by two turns
		const waits = new HeldHandlerWaits();
		const released: string[] = [];
		waits.hold(1, () => released.push("turn 1 a"));
		waits.hold(2, () => released.push("turn 2"));
		waits.hold(1, () => released.push("turn 1 b"));

		// when turn 1's deadline releases its waits
		const count = waits.release(1);

		// then only turn 1's waits were released
		expect(count).toBe(2);
		expect(released).toEqual(["turn 1 a", "turn 1 b"]);
		expect(waits.release(2)).toBe(1);
	});
});
