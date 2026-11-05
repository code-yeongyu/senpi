// oh-my-openagent#11419 regression: a turn ended, its reply was on screen, but clients kept showing it as running.
// The engine published agent_settled to session subscribers (RPC clients, the TUI) only after every extension
// agent_settled handler returned, so one slow or hung handler held the settle edge for up to the 20 min hard cap.
// agent_settled is notification-only: the settle must publish at once, and a stalled handler must stay visible
// in diagnostics instead of being hidden behind a stuck "Starting session..." indicator.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionHandlerStall } from "../../../src/core/extensions/handler-budget.ts";
import type { ExtensionAPI, ExtensionError } from "../../../src/core/extensions/types.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

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

function sessionLogEvents(harness: Harness): Array<Record<string, unknown>> {
	const path = join(harness.tempDir, "agent", "logs", "session.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("oh-my-openagent#11419 agent_settled publishes without waiting on extension handlers", () => {
	let harness: Harness | undefined;
	let release: (() => void) | undefined;

	afterEach(() => {
		release?.();
		release = undefined;
		harness?.cleanup();
		harness = undefined;
	});

	async function startWithHeldSettledHandler(settings: Partial<Settings>) {
		const order: string[] = [];
		const handlerEntered = Promise.withResolvers<void>();
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let holding = false;
		const created = await createHarness({
			settings,
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_end", () => {
						order.push("extension:agent_end");
					});
					pi.on("agent_before_settle", () => {
						order.push("extension:agent_before_settle");
					});
					// Holds the first settle only, the way one slow memory pass holds one turn end.
					pi.on("agent_settled", async () => {
						if (holding) return;
						holding = true;
						order.push("extension:agent_settled");
						handlerEntered.resolve();
						await held;
					});
				},
			],
		});
		harness = created;
		const settled = Promise.withResolvers<void>();
		created.session.subscribe((event) => {
			if (event.type === "agent_end" || event.type === "agent_settled") order.push(`subscriber:${event.type}`);
			if (event.type === "agent_settled") settled.resolve();
		});
		return { created, settled: settled.promise, handlerEntered: handlerEntered.promise, order };
	}

	it("publishes agent_settled to subscribers while an agent_settled handler never returns", async () => {
		// given an extension whose agent_settled handler never returns and no host cap that would stop waiting on it
		const { created, settled, handlerEntered, order } = await startWithHeldSettledHandler({
			extensionEventHandlerWarnMs: 0,
			extensionEventHandlerTimeoutMs: 0,
		});
		created.setResponses([fauxAssistantMessage([fauxText("the reply")])]);

		// when a turn ends
		void created.session.prompt("go");
		await withinRealTime(handlerEntered, "the agent_settled handler to start");

		// then subscribers hear the settle while the handler is still running, and the reply is persisted
		expect(order).toEqual([
			"extension:agent_end",
			"subscriber:agent_end",
			"extension:agent_before_settle",
			"subscriber:agent_settled",
			"extension:agent_settled",
		]);
		await withinRealTime(settled, "agent_settled to reach subscribers");
		expect(getAssistantTexts(created)).toEqual(["the reply"]);
		expect(created.session.isStreaming).toBe(false);
	}, 30_000);

	it.each([false, true])(
		"surfaces a rejecting settle handler after publication (yielded: %s)",
		async (yielded) => {
			// Subscribe before triggering: failures before yield reach extension_error listeners; late ones reach session.log.
			const entered = Promise.withResolvers<void>();
			const held = Promise.withResolvers<void>();
			release = held.resolve;
			let first = true;
			const created = await createHarness({
				settings: { extensionEventHandlerWarnMs: 0, extensionEventHandlerTimeoutMs: 0 },
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.on("agent_settled", async () => {
							if (!first) return;
							first = false;
							entered.resolve();
							await held.promise;
							throw new Error("settle handler failed");
						});
					},
				],
			});
			harness = created;
			const settled = Promise.withResolvers<void>();
			created.session.subscribe((event) => {
				if (event.type === "agent_settled") settled.resolve();
			});
			const failure = Promise.withResolvers<ExtensionError>();
			created.getExtensionRunner().onError((error) => failure.resolve(error));
			const lateFailure = stallStage(created, "late_failure");
			created.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			const prompt = created.session.prompt("one");
			await withinRealTime(entered.promise, "the rejecting handler to start");
			await withinRealTime(settled.promise, "settlement before the handler rejects");
			if (yielded) await withinRealTime(created.session.prompt("two"), "the next prompt");
			held.resolve();
			if (yielded) {
				await withinRealTime(lateFailure, "the late settle failure");
				expect(sessionLogEvents(created)).toContainEqual(
					expect.objectContaining({
						event: "extension_handler_stalled",
						handlerEvent: "agent_settled",
						stage: "late_failure",
						error: "settle handler failed",
					}),
				);
			} else {
				expect(await withinRealTime(failure.promise, "the settle extension error")).toMatchObject({
					event: "agent_settled",
					error: "settle handler failed",
				});
			}
			await withinRealTime(prompt, "the original prompt");
		},
		30_000,
	);

	it("still reports the stalled handler in session.log after the settle published", async () => {
		// given an agent_settled handler that outlives the warning budget
		const { created, settled } = await startWithHeldSettledHandler({
			extensionEventHandlerWarnMs: 50,
			extensionEventHandlerTimeoutMs: 0,
		});
		const warned = stallStage(created, "warn");
		created.setResponses([fauxAssistantMessage([fauxText("the reply")])]);

		// when a turn ends and the handler keeps running past the warning
		void created.session.prompt("go");
		await withinRealTime(settled, "agent_settled to reach subscribers");
		await withinRealTime(warned, "the stall warning");

		// then session.log names the held handler's event, so the slow extension stays diagnosable
		expect(sessionLogEvents(created)).toContainEqual(
			expect.objectContaining({ event: "extension_handler_stalled", handlerEvent: "agent_settled", stage: "warn" }),
		);
	}, 30_000);

	it("runs the next prompt to its reply while the previous agent_settled handler is still held", async () => {
		// given a settled turn whose agent_settled handler never returns
		const { created, settled } = await startWithHeldSettledHandler({
			extensionEventHandlerWarnMs: 0,
			extensionEventHandlerTimeoutMs: 0,
		});
		const errors: ExtensionError[] = [];
		created.getExtensionRunner().onError((error) => errors.push(error));
		created.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
		void created.session.prompt("one");
		await withinRealTime(settled, "the first settle");

		// when the person sends the next message
		await withinRealTime(created.session.prompt("two"), "the next prompt to finish");

		// then the next turn ran, its reply was persisted, and session.log says the held handler was released
		expect(getAssistantTexts(created)).toEqual(["first", "second"]);
		expect(sessionLogEvents(created)).toContainEqual(
			expect.objectContaining({
				event: "extension_handler_stalled",
				handlerEvent: "agent_settled",
				stage: "released",
			}),
		);
		// and the user saw no error: a person moving on is not a failure, and no deadline fired
		expect(errors).toEqual([]);
	}, 30_000);

	it("starts a prompt sent synchronously from an agent_settled subscriber without waiting on the held handler", async () => {
		// given a same-process subscriber that prompts inside its agent_settled callback, before any handler started
		const { created } = await startWithHeldSettledHandler({
			extensionEventHandlerWarnMs: 0,
			extensionEventHandlerTimeoutMs: 0,
		});
		const errors: ExtensionError[] = [];
		created.getExtensionRunner().onError((error) => errors.push(error));
		created.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
		const subscribed = Promise.withResolvers<void>();
		let second: Promise<void> | undefined;
		created.session.subscribe((event) => {
			if (event.type !== "agent_settled" || second !== undefined) return;
			second = created.session.prompt("two");
			subscribed.resolve();
		});

		// when the first turn settles
		void created.session.prompt("one");
		await withinRealTime(subscribed.promise, "the subscriber prompt");
		if (second === undefined) throw new Error("the subscriber did not prompt");
		await withinRealTime(second, "the subscriber prompt to finish");

		// then the second turn ran and nothing was reported as an error
		expect(getAssistantTexts(created)).toEqual(["first", "second"]);
		expect(errors).toEqual([]);
	}, 30_000);

	it("does not wait on a second slow agent_settled handler after a person's prompt released the first", async () => {
		// given two extensions whose agent_settled handlers both hold the first settle
		const holds: Array<() => void> = [];
		const created = await createHarness({
			settings: { extensionEventHandlerWarnMs: 0, extensionEventHandlerTimeoutMs: 0 },
			extensionFactories: [0, 1].map(() => (pi: ExtensionAPI) => {
				let holding = false;
				pi.on("agent_settled", async () => {
					if (holding) return;
					holding = true;
					await new Promise<void>((resolve) => holds.push(resolve));
				});
			}),
		});
		harness = created;
		release = () => {
			for (const resolve of holds) resolve();
		};
		const settled = Promise.withResolvers<void>();
		created.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.resolve();
		});
		created.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
		void created.session.prompt("one");
		await withinRealTime(settled.promise, "the first settle");

		// when the person sends the next message
		await withinRealTime(created.session.prompt("two"), "the next prompt to finish");

		// then the next turn ran without waiting on either held handler
		expect(getAssistantTexts(created)).toEqual(["first", "second"]);
	}, 30_000);
});
