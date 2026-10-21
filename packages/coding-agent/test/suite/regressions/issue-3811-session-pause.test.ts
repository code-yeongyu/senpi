import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { createLoopExtension, type LoopController } from "../../../src/core/extensions/builtin/loop/index.ts";
import type { LoopTimerPort } from "../../../src/core/extensions/builtin/loop/scheduler.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { sessionPauseHistory } from "../../../src/core/session-pause.ts";
import { createHarness } from "../harness.ts";

// senpi#3811: real admission and transcript custody, with synthetic provider responses.
function nextNotice(session: AgentSession, disposition: "notice_persisted" | "model_consumed"): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = AbortSignal.timeout(5_000);
		const timeout = () => {
			unsubscribe();
			reject(new Error(`No ${disposition} receipt within 5s`));
		};
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "session_notice" || event.disposition !== disposition) return;
			deadline.removeEventListener("abort", timeout);
			unsubscribe();
			resolve();
		});
		deadline.addEventListener("abort", timeout, { once: true });
	});
}

it("persists Stop and its notices across a session-file reopen", async () => {
	const harness = await createHarness({ persistSession: true });
	try {
		await harness.session.abort();
		await harness.session.sendCustomMessage(
			{ customType: "late", content: "retained", display: false },
			{ triggerTurn: true },
		);
		const file = harness.session.sessionFile;
		if (!file) throw new Error("Missing persisted session");
		// When reopened, the same pause and notice survive without a model call.
		const reopened = SessionManager.open(file);
		const state = reopened.reduceHistory(sessionPauseHistory);
		expect(state.paused).toBe(true);
		expect(state.noticeIds).toHaveLength(1);
		expect(reopened.getEntry(state.noticeIds[0])).toMatchObject({ type: "custom_message", content: "retained" });
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("distinguishes external notice custody from model consumption", async () => {
	const harness = await createHarness({ persistSession: true });
	try {
		await harness.session.abort();
		const input = { delivery_id: "delivery", text: "External result", deliverAs: "followUp" as const };
		expect(harness.session.externalAdmission.admit(input).kind).toBe("notice_persisted");
		expect(harness.session.externalAdmission.admit(input).kind).toBe("already_admitted");
		expect(harness.session.externalAdmission.list()).toEqual({ pending: [], emitted: [], notices: ["delivery"] });
		harness.setResponses([fauxAssistantMessage("I read the external result")]);
		const consumed = nextNotice(harness.session, "model_consumed");
		await harness.session.prompt("Continue");
		await consumed;
		expect(harness.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["delivery"] });
		expect(harness.faux.state.callCount).toBe(1);
	} finally {
		harness.cleanup();
	}
});

it("settles an unpersisted custom-message receipt when its queue is cleared", async () => {
	const entered = Promise.withResolvers<void>();
	const response = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
	const harness = await createHarness();
	try {
		harness.setResponses([
			async () => {
				entered.resolve();
				return response.promise;
			},
		]);
		const prompt = harness.session.prompt("Hold the provider");
		await entered.promise;
		const failures: unknown[] = [];
		const receipts: unknown[] = [];
		await harness.session.sendCustomMessage(
			{ customType: "completion", content: "Not persisted yet", display: true },
			{
				deliverAs: "followUp",
				onPersisted: (value) => receipts.push(value),
				onPersistenceFailed: (error) => failures.push(error),
			},
		);
		harness.session.clearQueue();
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(Error);
		expect(receipts).toEqual([]);
		response.resolve(fauxAssistantMessage("Finished"));
		await prompt;
		expect(harness.faux.state.callCount).toBe(1);
	} finally {
		response.resolve(fauxAssistantMessage("Finished"));
		harness.cleanup();
	}
}, 10_000);

it("delivers an unconsumed notice after navigating away from its branch", async () => {
	const harness = await createHarness();
	try {
		const target = harness.session.sessionManager.appendCustomEntry("navigation-target", {});
		await harness.session.abort();
		await harness.session.sendCustomMessage(
			{ customType: "late", content: "UNCONSUMED_NOTICE_3811", display: true },
			{ triggerTurn: true },
		);
		await harness.session.navigateTree(target, { summarize: false });
		expect(harness.session.pauseState).toEqual({ paused: true, noticeCount: 1 });
		harness.setResponses([fauxAssistantMessage("Read the notice")]);
		await harness.session.prompt("Continue from this branch");
		expect(JSON.stringify(harness.faux.getCallLog()[0].context)).toContain("UNCONSUMED_NOTICE_3811");
		expect(harness.session.pauseState).toEqual({ paused: false, noticeCount: 0 });
	} finally {
		harness.cleanup();
	}
});

it("only resumes after accepted human input, not a command-shaped extension message", async () => {
	const harness = await createHarness();
	try {
		await harness.session.abort();
		await harness.session.sendUserMessage("/resume", { expandPromptTemplates: true });
		await expect(harness.session.prompt("/not-a-command")).rejects.toThrow();
		expect(harness.session.pauseState.paused).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
		harness.setResponses([fauxAssistantMessage("Resumed explicitly")]);
		await harness.session.prompt("/resume");
		expect(harness.session.pauseState.paused).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	} finally {
		harness.cleanup();
	}
});

it("a Stop during human preflight cannot be undone by that older submission", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	try {
		harness.setResponses([fauxAssistantMessage("Must not run")]);
		const prompt = harness.session.prompt("Pending human submission");
		await entered.promise;
		await harness.session.abort();
		release.resolve();
		await prompt;
		expect(harness.session.pauseState).toEqual({ paused: true, noticeCount: 1 });
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		release.resolve();
		harness.cleanup();
	}
}, 10_000);

it("a paused loop tick persists a notice and keeps its timer and spend budget", async () => {
	let now = 1_700_000_000_000;
	let controller: LoopController | undefined;
	const armed = new Map<string, number>();
	const timers: LoopTimerPort = {
		arm: (id, dueAt) => {
			armed.set(id, dueAt);
		},
		cancel: (id) => {
			armed.delete(id);
		},
		cancelAll: () => {
			armed.clear();
		},
	};
	const harness = await createHarness({
		extensionFactories: [
			createLoopExtension({
				clock: { now: () => now },
				timers: () => timers,
				onControllerReady: (value) => {
					controller = value;
				},
				readState: async () => null,
				writeState: async () => {},
			}),
		],
	});
	try {
		if (!controller) throw new Error("Loop controller missing");
		await harness.session.bindExtensions({ mode: "rpc" });
		await harness.session.abort();
		const notice = nextNotice(harness.session, "notice_persisted");
		const created = await controller.startFixed({
			originalArgs: "1m check",
			prompt: "Check progress",
			requestedInterval: { value: 1, unit: "m", raw: "1m" },
		});
		await notice;
		if (!created.ok) throw new Error(created.message);
		const before = controller.getState().entries[created.loopId];
		expect(before.tickCount).toBe(0);
		expect(armed.has(created.loopId)).toBe(true);
		now += 60_000;
		const tickNotice = nextNotice(harness.session, "notice_persisted");
		await controller.fireDue(created.loopId);
		await tickNotice;
		expect(harness.faux.state.callCount).toBe(0);
		expect(controller.getState().entries[created.loopId].tickCount).toBe(0);
		expect(armed.get(created.loopId)).toBeGreaterThan(now);
		expect(harness.session.pauseState.noticeCount).toBe(2);
	} finally {
		harness.cleanup();
	}
}, 10_000);
