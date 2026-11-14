import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ExternalWakePermit,
	type ExternalWakeSource,
	SESSION_CONTROL_DELIVERY_TYPE,
	SESSION_CONTROL_EXTERNAL_WAKE_TYPE,
} from "../../src/core/extensions/types.ts";
import { deliveryIdOf } from "../../src/core/external-admission.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { getModelRuntime } from "../model-runtime-test-utils.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function harness(): Promise<Harness> {
	const created = await createHarness({ persistSession: true });
	harnesses.push(created);
	return created;
}

function nextEvent(target: Harness, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

async function holdTurn(target: Harness): Promise<{ release: () => void; settled: Promise<void> }> {
	const gate = Promise.withResolvers<void>();
	target.setResponses([
		async () => {
			await gate.promise;
			return fauxAssistantMessage("first reply");
		},
		fauxAssistantMessage("second reply"),
		fauxAssistantMessage("third reply"),
	]);
	const started = nextEvent(target, "agent_start");
	const settled = target.session.prompt("start work");
	await started;
	return { release: () => gate.resolve(), settled };
}

function deliveryEntries(target: Harness): readonly { delivery_id: string | undefined; content: unknown }[] {
	return target.sessionManager.getEntries().flatMap((entry) =>
		entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE
			? [
					{
						delivery_id: deliveryIdOf({ role: "custom", ...entry, display: entry.display, timestamp: 0 }),
						content: entry.content,
					},
				]
			: [],
	);
}

describe("external message admission", () => {
	it("starts a turn when idle, writes delivery_id provenance, and moves the id from pending to emitted", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const idle = nextEvent(target, "agent_idle");
		expect(admission.admit({ delivery_id: "d-idle", text: "hello from A", deliverAs: "followUp" })).toEqual({
			kind: "started",
			turn_epoch: 0,
		});
		expect(admission.list().pending).toEqual(["d-idle"]);
		expect(admission.admit({ delivery_id: "d-idle", text: "hello from A", deliverAs: "followUp" }).kind).toBe(
			"already_admitted",
		);
		await idle;
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-idle"] });
		expect(deliveryEntries(target)).toEqual([{ delivery_id: "d-idle", content: "hello from A" }]);
		const file = target.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		expect(readFileSync(file, "utf8")).toContain('"delivery_id":"d-idle"');
		expect(admission.admit({ delivery_id: "d-idle", text: "again", deliverAs: "followUp" }).kind).toBe(
			"already_admitted",
		);
	});

	it("mid-turn: CAS on turn_epoch, one enqueue per delivery_id across both queues", async () => {
		const target = await harness();
		const turn = await holdTurn(target);
		const steer = vi.spyOn(target.agent, "steer");
		const followUp = vi.spyOn(target.agent, "followUp");
		const admission = target.session.externalAdmission;
		const epoch = admission.turnEpoch;
		expect(epoch).toBe(1);

		expect(admission.admit({ delivery_id: "s-stale", text: "x", deliverAs: "steer", expected_turn_id: 0 })).toEqual({
			kind: "turn_conflict",
			turn_epoch: 1,
		});
		expect(admission.admit({ delivery_id: "s-none", text: "x", deliverAs: "steer" }).kind).toBe("turn_conflict");
		expect(
			admission.admit({ delivery_id: "s-1", text: "steer me", deliverAs: "steer", expected_turn_id: epoch }).kind,
		).toBe("steered");
		expect(admission.admit({ delivery_id: "f-1", text: "later", deliverAs: "followUp" }).kind).toBe("queued");
		expect(
			admission.admit({ delivery_id: "f-1", text: "later", deliverAs: "steer", expected_turn_id: epoch }).kind,
		).toBe("already_admitted");
		expect(admission.admit({ delivery_id: "s-1", text: "steer me", deliverAs: "followUp" }).kind).toBe(
			"already_admitted",
		);
		expect(steer).toHaveBeenCalledTimes(1);
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(admission.list()).toEqual({ pending: ["s-1", "f-1"], emitted: [] });

		turn.release();
		await turn.settled;
		await target.session.waitForIdle();
		expect(deliveryEntries(target).map((entry) => entry.delivery_id)).toEqual(["s-1", "f-1"]);
		expect(admission.list()).toEqual({ pending: [], emitted: ["s-1", "f-1"] });
	});

	it("holds while the user has a draft, without enqueueing anything", async () => {
		const target = await harness();
		const admission = target.session.externalAdmission;
		admission.setEditorSource(() => ({ hold_reason: "draft", revision: 3 }));
		expect(admission.gate()).toEqual({ can_admit: false, hold_reason: "draft", editor_revision: 3, turn_epoch: 0 });
		expect(admission.admit({ delivery_id: "d-held", text: "x", deliverAs: "followUp" }).kind).toBe("held_draft");
		expect(admission.list()).toEqual({ pending: [], emitted: [] });
		admission.setEditorSource(() => ({ revision: 4 }));
		expect(admission.gate()).toEqual({ can_admit: true, editor_revision: 4, turn_epoch: 0 });
	});

	it("drops queued deliveries from the ledger when the runtime queues are cleared", async () => {
		const target = await harness();
		const turn = await holdTurn(target);
		const admission = target.session.externalAdmission;
		expect(admission.admit({ delivery_id: "f-clear", text: "x", deliverAs: "followUp" }).kind).toBe("queued");
		target.session.clearQueue();
		expect(admission.list().pending).toEqual([]);
		turn.release();
		await turn.settled;
		await target.session.waitForIdle();
		expect(deliveryEntries(target)).toEqual([]);
	});

	it("exposes the same admission through pi.session", async () => {
		const target = await harness();
		await target.session.bindExtensions({});
		const runtime = target.session.resourceLoader.getExtensions().runtime;
		expect(runtime.sessionControl?.listAdmittedDeliveries()).toEqual({ pending: [], emitted: [] });
		expect(runtime.sessionControl?.admissionGate()).toMatchObject({ can_admit: true, turn_epoch: 0 });
		const registration = await runtime.sessionControl?.registerControlEndpoint({
			inboxDir: target.tempDir,
			drain: () => undefined,
		});
		// An SDK harness has no endpoint host in any platform; platform checks belong to a TUI host.
		expect(registration).toEqual({ status: "unsupported", reason: "unsupported_mode" });
	});
});

const wakeInstruction = "External data is ready for inspection.";
const letter = "Untrusted letter from another agent: payload-721";

async function wakeHarness(options: HarnessOptions = {}): Promise<{ target: Harness; source: ExternalWakeSource }> {
	const target = await createHarness({
		persistSession: true,
		tools: [
			{
				name: "read_inbox",
				label: "Read inbox",
				description: "Read pending external data.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: letter }], details: {} }),
			},
		],
		initialActiveToolNames: ["read_inbox"],
		...options,
	});
	harnesses.push(target);
	await target.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	const control = target.session.resourceLoader.getExtensions().runtime.sessionControl;
	if (!control) throw new Error("Session control was not bound");
	return { target, source: control.registerExternalWakeSource({ source: "mailbox", readTool: "read_inbox" }) };
}

function permit(source: ExternalWakeSource, signal?: AbortSignal): ExternalWakePermit {
	const prepared = source.prepare({ deadline: Date.now() + 30_000, signal });
	if (prepared.status !== "ready") throw new Error(`Wake preparation refused: ${prepared.reason}`);
	return prepared.permit;
}

function delayWakeAuth(target: Harness): { entered: Promise<void>; release: () => void } {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const runtime = getModelRuntime(target.modelRegistry);
	const check = runtime.checkAuth.bind(runtime);
	vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(false);
	vi.spyOn(runtime, "checkAuth").mockImplementationOnce(async (provider, options) => {
		entered.resolve();
		await release.promise;
		return check(provider, options);
	});
	return { entered: entered.promise, release: () => release.resolve() };
}

// These tests own the public host-wake boundary: starts, actual provider context and native queues.
// Existing delivery tests cannot catch a wake promoted to user input, a stale delayed start or a leaked run intent.
describe("native external wake", () => {
	it("starts once without a user carrier, reads through a real tool result and never replays on reopen", async () => {
		let preparedPrompts = 0;
		const { target, source } = await wakeHarness({
			extensionFactories: [
				(pi) => {
					pi.on(
						"before_agent_start",
						(event) => ({ systemPrompt: `${event.systemPrompt}\nConfigured policy stays active.` }),
						{ previewSafe: true },
					);
					pi.on("before_agent_start", () => {
						preparedPrompts += 1;
						return {
							message: {
								customType: "prompt-context",
								content: "pending context for the real prompt",
								display: false,
							},
						};
					});
				},
			],
		});
		target.setResponses([
			fauxAssistantMessage([fauxToolCall("read_inbox", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Read the letter."),
			fauxAssistantMessage("ordinary reply"),
		]);
		const input = { wake_id: "letter-1", permit: permit(source) };
		const first = source.wake(input);
		const duplicate = source.wake(input);
		expect(duplicate).toBe(first);
		expect(await first).toEqual({ status: "started", turn_epoch: 1 });
		expect(target.eventsOfType("agent_start")).toHaveLength(1);
		const calls = target.faux.getCallLog();
		expect(calls).toHaveLength(2);
		expect(preparedPrompts).toBe(0);
		expect(calls.map((call) => call.options?.requiresNonUserContinuation)).toEqual([true, true]);
		expect(calls[0].context.systemPrompt).toContain(wakeInstruction);
		expect(calls[0].context.systemPrompt).toContain("Configured policy stays active.");
		expect(calls[0].context.messages).toEqual([]);
		expect(calls[1].context.messages.some((message) => message.role === "user")).toBe(false);
		expect(calls[1].context.messages.find((message) => message.role === "toolResult")).toMatchObject({
			toolName: "read_inbox",
			content: [{ type: "text", text: letter }],
		});
		expect(
			target.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_EXTERNAL_WAKE_TYPE,
				),
		).toHaveLength(1);
		expect(target.agent.hasQueuedMessages()).toBe(false);
		await target.session.prompt("ordinary user task");
		expect(preparedPrompts).toBe(1);
		expect(JSON.stringify(target.faux.getCallLog()[2].context.messages)).toContain(
			"pending context for the real prompt",
		);
		expect(target.faux.getCallLog()[2].options?.requiresNonUserContinuation).toBe(false);
		expect(target.faux.getCallLog()[2].context.systemPrompt).not.toContain(wakeInstruction);
		const file = target.sessionManager.getSessionFile();
		if (!file) throw new Error("Missing persisted session");
		source.dispose();
		target.session.dispose();
		const reopened = await wakeHarness({ sessionManager: SessionManager.open(file) });
		expect(reopened.target.faux.state.callCount).toBe(0);
		expect(await reopened.source.wake({ wake_id: "letter-1", permit: permit(reopened.source) })).toEqual({
			status: "started",
			turn_epoch: 1,
		});
		expect(reopened.target.faux.state.callCount).toBe(0);
	});

	it("refuses a preview that would add a user carrier without consuming ordinary prompt context", async () => {
		const { target, source } = await wakeHarness({
			extensionFactories: [
				(pi) => {
					pi.on(
						"before_agent_start",
						() => ({
							message: {
								customType: "preview-carrier",
								content: "must remain outside native wake",
								display: false,
							},
						}),
						{ previewSafe: true },
					);
				},
			],
		});
		expect(await source.wake({ wake_id: "unsafe-preview", permit: permit(source) })).toEqual({
			status: "refused",
			reason: "unsupported",
		});
		expect(target.faux.state.callCount).toBe(0);
		expect(target.agent.hasQueuedMessages()).toBe(false);
	});

	it.each(["draft", "edit-cleared", "stop", "expired", "abort", "retire", "tool-removed", "closed-reopened"] as const)(
		"refuses %s after asynchronous preparation, without queueing or reviving it",
		async (change) => {
			const { target, source } = await wakeHarness();
			const auth = delayWakeAuth(target);
			const cancellation = new AbortController();
			const input = { wake_id: "delayed", permit: permit(source, cancellation.signal) };
			const waking = source.wake(input);
			await auth.entered;
			let stop: Promise<void> | undefined;
			switch (change) {
				case "draft":
					target.session.externalAdmission.setEditorSource(() => ({ revision: 1, hold_reason: "draft" }));
					break;
				case "edit-cleared":
					target.session.externalAdmission.setEditorSource(() => ({ revision: 2 }));
					break;
				case "stop":
					stop = target.session.stop();
					break;
				case "expired":
					vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001);
					break;
				case "abort":
					cancellation.abort();
					break;
				case "retire":
					source.dispose();
					break;
				case "tool-removed":
					target.session.setActiveToolsByName([]);
					break;
				case "closed-reopened":
					target.session.externalAdmission.close("handover");
					target.session.externalAdmission.reopen();
					break;
			}
			auth.release();
			expect(await waking).toMatchObject({ status: "refused" });
			await stop;
			expect(target.faux.state.callCount).toBe(0);
			expect(target.eventsOfType("agent_start")).toHaveLength(0);
			expect(target.agent.hasQueuedMessages()).toBe(false);
			expect(
				target.sessionManager
					.getEntries()
					.some(
						(entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_EXTERNAL_WAKE_TYPE,
					),
			).toBe(false);
			expect(await source.wake(input)).toEqual(await waking);
			vi.restoreAllMocks();
			target.session.externalAdmission.setEditorSource(undefined);
			target.setResponses([fauxAssistantMessage("ordinary reply")]);
			await target.session.prompt("ordinary work after a refused wake");
			expect(target.faux.state.callCount).toBe(1);
			expect(target.faux.getCallLog()[0].context.systemPrompt).not.toContain(wakeInstruction);
		},
	);

	it("cannot copy a permit, spend it on another intent or use another source's permit", async () => {
		const { target, source } = await wakeHarness();
		const issued = permit(source);
		expect(await source.wake({ wake_id: "copy", permit: { ...issued } })).toEqual({
			status: "refused",
			reason: "invalid_permit",
		});
		const control = target.session.resourceLoader.getExtensions().runtime.sessionControl;
		if (!control) throw new Error("Session control is not bound");
		const other = control.registerExternalWakeSource({ source: "other", readTool: "read_inbox" });
		expect(await other.wake({ wake_id: "foreign", permit: issued })).toEqual({
			status: "refused",
			reason: "invalid_permit",
		});
		target.setResponses([fauxAssistantMessage("done")]);
		await source.wake({ wake_id: "first", permit: issued });
		expect(await source.wake({ wake_id: "different", permit: issued })).toEqual({
			status: "refused",
			reason: "invalid_permit",
		});
		expect(target.faux.state.callCount).toBe(1);
	});

	it("retires issued permits with the actual extension generation on reload", async () => {
		const { target, source } = await wakeHarness();
		const issued = permit(source);
		await target.session.reload();
		expect(await source.wake({ wake_id: "old-generation", permit: issued })).toEqual({
			status: "refused",
			reason: "stale",
		});
		expect(target.faux.state.callCount).toBe(0);
	});

	it("lets human input supersede delayed wake preparation without stealing or queueing it", async () => {
		const { target, source } = await wakeHarness();
		const auth = delayWakeAuth(target);
		target.setResponses([fauxAssistantMessage("human answer")]);
		const waking = source.wake({ wake_id: "user-wins", permit: permit(source) });
		await auth.entered;
		const human = target.session.prompt("human task wins");
		auth.release();
		expect(await waking).toMatchObject({ status: "refused" });
		await human;
		expect(target.faux.state.callCount).toBe(1);
		expect(JSON.stringify(target.faux.getCallLog()[0].context)).toContain("human task wins");
		expect(target.faux.getCallLog()[0].context.systemPrompt).not.toContain(wakeInstruction);
		expect(target.agent.hasQueuedMessages()).toBe(false);
	});

	it("cancels synchronously from the native start notification before any provider call", async () => {
		const { target, source } = await wakeHarness();
		const cancellation = new AbortController();
		let cancelledAtStart = false;
		target.session.subscribe((event) => {
			if (
				event.type !== "entry_appended" ||
				event.entry.type !== "custom" ||
				event.entry.customType !== "engine-turn-start"
			)
				return;
			cancelledAtStart = true;
			cancellation.abort();
		});
		target.setResponses([fauxAssistantMessage("must not request this response")]);
		expect(
			await source.wake({ wake_id: "cancel-at-start", permit: permit(source, cancellation.signal) }),
		).toMatchObject({ status: "started" });
		expect(cancelledAtStart).toBe(true);
		expect(target.faux.state.callCount).toBe(0);
		expect(target.agent.hasQueuedMessages()).toBe(false);
	});

	it("drops the wake instruction when queued human input takes over the same native run", async () => {
		const { target, source } = await wakeHarness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		target.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("wake done");
			},
			fauxAssistantMessage("ordinary done"),
		]);
		const waking = source.wake({ wake_id: "queued-user", permit: permit(source) });
		await entered.promise;
		await target.session.prompt("ordinary queued user task", { streamingBehavior: "followUp" });
		release.resolve();
		await waking;
		const ordinary = target.faux.getCallLog()[1].context;
		expect(JSON.stringify(ordinary.messages)).toContain("ordinary queued user task");
		expect(ordinary.systemPrompt).not.toContain(wakeInstruction);
		expect(target.faux.getCallLog()[1].options?.requiresNonUserContinuation).toBe(false);
	});

	it.each([false, true])(
		"keeps wake ownership through a retry and respects cancellation=%s during backoff",
		async (cancel) => {
			const { target, source } = await wakeHarness({
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			});
			const cancellation = new AbortController();
			const retry = nextEvent(target, "auto_retry_start");
			const secondEntered = Promise.withResolvers<void>();
			const releaseSecond = Promise.withResolvers<void>();
			target.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
				async () => {
					secondEntered.resolve();
					await releaseSecond.promise;
					return fauxAssistantMessage("recovered");
				},
			]);
			let settled = false;
			const waking = source
				.wake({ wake_id: "retry", permit: permit(source, cancellation.signal) })
				.then((result) => {
					settled = true;
					return result;
				});
			await retry;
			expect(settled).toBe(false);
			if (cancel) cancellation.abort();
			else {
				await secondEntered.promise;
				expect(settled).toBe(false);
				expect(target.faux.getCallLog()[1].context.systemPrompt).toContain(wakeInstruction);
				releaseSecond.resolve();
			}
			expect(await waking).toMatchObject({ status: "started" });
			expect(target.faux.state.callCount).toBe(cancel ? 1 : 2);
			expect(target.session.isRetrying).toBe(false);
			expect(target.session.systemPrompt).not.toContain(wakeInstruction);
		},
	);
});

describe("persistHeaderNow and the header-only exit rule", () => {
	it("writes the header before any assistant message and keeps appending after it", async () => {
		const target = await harness();
		const file = target.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		expect(existsSync(file)).toBe(false);
		await target.sessionManager.persistHeaderNow();
		const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "{}");
		expect(header).toMatchObject({ type: "session", id: target.session.sessionId });
		target.setResponses([fauxAssistantMessage("reply")]);
		await target.session.prompt("hi");
		const types = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).type);
		expect(types.filter((type) => type === "session")).toHaveLength(1);
		expect(types).toContain("message");
		expect(await target.sessionManager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("entries persisted while the asynchronous header write runs land after the header, once", async () => {
		const target = await harness();
		const manager = target.sessionManager;
		const file = manager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		const writing = manager.persistHeaderNow();
		manager.appendMessage({ role: "user", content: "during the header write", timestamp: Date.now() });
		manager.appendMessage(fauxAssistantMessage("assistant during the header write"));
		expect(manager.isTranscriptFlushed()).toBe(false);
		await writing;
		expect(manager.isTranscriptFlushed()).toBe(true);
		manager.appendCustomEntry("after", { n: 1 });
		const lines = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ type: "session", id: target.session.sessionId });
		expect(lines.slice(1).map((line) => line.id)).toEqual(manager.getEntries().map((entry) => entry.id));
	});

	it("removes a header-only file and returns to buffering", async () => {
		const target = await harness();
		const file = target.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("no session file");
		await target.sessionManager.persistHeaderNow();
		expect(await target.sessionManager.discardHeaderOnlyFile()).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(target.sessionManager.isTranscriptFlushed()).toBe(false);
	});
});
