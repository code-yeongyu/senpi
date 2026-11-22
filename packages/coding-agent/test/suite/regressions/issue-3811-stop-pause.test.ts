import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getTerminalNotificationDelivery } from "../../../src/core/extensions/builtin/terminal/notify.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { releaseQuestionInput } from "../../../src/core/question-input.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;

interface Probe {
	api?: ExtensionAPI;
	context?: ExtensionContext;
	releaseTool: () => void;
	toolStarted: Promise<void>;
}

function probeExtension(probe: Probe) {
	return (pi: ExtensionAPI) => {
		probe.api = pi;
		pi.on("session_start", (_event, ctx) => {
			probe.context = ctx;
		});
	};
}

async function pausedFixture(): Promise<{ fixture: Fixture; probe: Probe }> {
	let releaseTool: () => void = () => {};
	let toolStarted: () => void = () => {};
	const release = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	const started = new Promise<void>((resolve) => {
		toolStarted = resolve;
	});
	const probe: Probe = { releaseTool: () => releaseTool(), toolStarted: started };
	const fixture = await createIdentityHarness({
		extensionFactories: [probeExtension(probe)],
		tools: [
			{
				name: "hold",
				label: "Hold",
				description: "Deterministic interrupt boundary",
				parameters: Type.Object({}),
				execute: async () => {
					toolStarted();
					await release;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	await fixture.session.bindExtensions({ mode: "rpc" });
	fixture.harness.setResponses([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("a later turn"),
		fauxAssistantMessage("another later turn"),
	]);
	return { fixture, probe };
}

async function twoStopFixture(): Promise<{
	fixture: Fixture;
	probe: Probe;
	started: () => Promise<void>;
	release: () => void;
}> {
	const waiters: Array<() => void> = [];
	const gates: Array<() => void> = [];
	const probe: Probe = { releaseTool: () => {}, toolStarted: Promise.resolve() };
	const fixture = await createIdentityHarness({
		extensionFactories: [probeExtension(probe)],
		tools: [
			{
				name: "hold",
				label: "Hold",
				description: "Deterministic interrupt boundary, one gate per call",
				parameters: Type.Object({}),
				execute: async () => {
					waiters.shift()?.();
					await new Promise<void>((resolve) => gates.push(resolve));
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	await fixture.session.bindExtensions({ mode: "rpc" });
	fixture.harness.setResponses([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("delivered again"),
		fauxAssistantMessage("spare"),
	]);
	return {
		fixture,
		probe,
		started: () => new Promise<void>((resolve) => waiters.push(resolve)),
		release: () => gates.shift()?.(),
	};
}

function wakeOutcome(fixture: Fixture): Promise<"turn" | "notice"> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("the late wake produced neither a turn nor a notice"));
		}, 10_000);
		const unsubscribe = fixture.session.subscribe((event) => {
			const type: string = event.type;
			const kind = type === "agent_start" ? "turn" : type === "session_notice" ? "notice" : undefined;
			if (kind === undefined) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(kind);
		});
	});
}

function noticesConsumed(fixture: Fixture): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("the held notices were never consumed"));
		}, 10_000);
		const unsubscribe = fixture.session.subscribe((event) => {
			const type: string = event.type;
			if (type !== "session_notice" || Reflect.get(event, "disposition") !== "model_consumed") return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
}

async function lateTerminalCompletion(fixture: Fixture, probe: Probe): Promise<"turn" | "notice"> {
	if (probe.api === undefined || probe.context === undefined) throw new Error("extension binding unavailable");
	const outcome = wakeOutcome(fixture);
	const delivery = getTerminalNotificationDelivery({
		sendMessage: probe.api.sendMessage,
		getContext: () => probe.context,
		getMode: () => "wake",
	});
	if (delivery === undefined) throw new Error("terminal delivery unavailable");
	delivery.send("Synthetic background process finished.");
	const kind = await outcome;
	await settle(fixture);
	return kind;
}

async function settle(fixture: Fixture): Promise<void> {
	await fixture.session.waitForIdle();
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	await fixture.session.waitForIdle();
}

function resumeDirectives(fixture: Fixture): number {
	return fixture.session.messages.filter(
		(message) => message.role === "custom" && Reflect.get(message, "customType") === "session-resumed",
	).length;
}

type StateData = { paused?: boolean; pausedNoticeCount?: number; pausedHeldInputCount?: number };
async function state(rpc: { send(command: object): Promise<unknown> }): Promise<StateData> {
	const response = (await rpc.send({ type: "get_state" })) as { data: StateData };
	return response.data;
}

describe("senpi#3811 user Stop pauses the session", () => {
	const fixtures: Fixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	it("keeps a late terminal completion as a notice after an interactive RPC Stop", async () => {
		// Given a running turn and an interactive client
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;

		// When the user presses Stop, the tool finishes, and a background completion arrives later
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true, clearQueue: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");

		// Then no new provider call was made and the wake is counted as a held notice
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(await state(rpc)).toMatchObject({ paused: true, pausedNoticeCount: 1 });
	});

	it("does not let an extension sendUserMessage release the pause", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);

		probe.api?.sendUserMessage("An extension is not a human");
		await settle(fixture);

		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(await state(rpc)).toMatchObject({ paused: true, pausedNoticeCount: 1 });
	});

	it("releases the pause on a human prompt and delivers the held notice in that one turn", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");

		const consumed = noticesConsumed(fixture);
		await rpc.send({ type: "prompt", message: "Carry on" });
		await consumed;
		await settle(fixture);

		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(await state(rpc)).toMatchObject({ paused: false, pausedNoticeCount: 0 });
	});

	it("keeps a plain abort as a plain abort: no pause is written", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);

		expect((await state(rpc)).paused ?? false).toBe(false);
	});

	it("refuses intent stop from a connection that never declared interactive_user", async () => {
		const { fixture } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();

		const answer = (await rpc.send({ type: "abort", intent: "stop" })) as { success: boolean; error?: string };

		expect(answer.success).toBe(false);
		expect(answer.error).toContain("stop_requires_interactive_client");
	});

	it("keeps the pause and its notice count across a reopen", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");

		const reopened = await fixture.reopen();

		expect(await state(reopened)).toMatchObject({ paused: true, pausedNoticeCount: 1 });
	});

	it("pauses through the TUI Stop helper too", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stopHelper = Reflect.get(InteractiveMode.prototype, "abortAndFireQueuedMessages");
		if (typeof stopHelper !== "function") throw new Error("TUI stop helper unavailable");
		const stopping = stopHelper.call({
			session: fixture.session,
			clearAllQueues: () => fixture.session.clearQueue({ abortWillFollow: true }),
			updatePendingMessagesDisplay: () => {},
			editor: { getText: () => "", setText: () => {} },
		});
		probe.releaseTool();
		await Promise.all([prompt, stopping]);
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");

		expect(fixture.harness.faux.state.callCount).toBe(1);
	});
	for (const behavior of ["steer", "followUp"] as const) {
		it(`resumes on a ${behavior} that names a person as its origin, whatever its source`, async () => {
			// Given a session paused by an interactive Stop
			const { fixture, probe } = await pausedFixture();
			fixtures.push(fixture);
			const rpc = fixture.bind();
			await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
			const prompt = fixture.session.prompt("Work on it");
			await probe.toolStarted;
			const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
			probe.releaseTool();
			await Promise.all([prompt, stop]);
			await settle(fixture);

			// When a person's answer arrives through an extension-sourced steer or follow-up
			await fixture.session[behavior]("Answer: use staging", undefined, {
				source: "extension",
				inputOrigin: "person",
			});
			await settle(fixture);

			// Then the explicit person origin releases the pause and runs one turn
			expect(fixture.harness.faux.state.callCount).toBe(2);
			expect(await state(rpc)).toMatchObject({ paused: false });
		});
	}

	it("continues the interrupted work with one turn on Resume when no wake was held", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);

		await fixture.session.resumeSession();
		await settle(fixture);

		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(resumeDirectives(fixture)).toBe(1);
		expect(await state(rpc)).toMatchObject({ paused: false });
	});

	it("tells the model about the interrupted turn when a human message releases the Stop", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);

		await rpc.send({ type: "prompt", message: "Carry on" });
		await settle(fixture);

		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(resumeDirectives(fixture)).toBe(1);
	});
	it("holds human input only from an interactive connection, once per input id and revision", async () => {
		const { fixture } = await pausedFixture();
		fixtures.push(fixture);
		const bot = fixture.bind();
		const refused = (await bot.send({ type: "hold_input", inputId: "g-1", revision: 1, text: "x" })) as {
			success: boolean;
			error?: string;
		};
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });

		const first = (await rpc.send({ type: "hold_input", inputId: "g-1", revision: 1, text: "Use staging" })) as {
			data: { duplicate?: boolean };
		};
		const replay = (await rpc.send({ type: "hold_input", inputId: "g-1", revision: 1, text: "Use staging" })) as {
			data: { duplicate?: boolean };
		};
		const conflict = (await rpc.send({ type: "hold_input", inputId: "g-1", revision: 2, text: "Use prod" })) as {
			success: boolean;
			error?: string;
		};

		expect(refused.success).toBe(false);
		expect(refused.error).toContain("hold_input_requires_interactive_client");
		expect(first.data.duplicate).toBe(false);
		expect(replay.data.duplicate).toBe(true);
		expect(conflict.success).toBe(false);
		expect(conflict.error).toContain("input_id_conflict");
		expect(await state(rpc)).toMatchObject({ pausedHeldInputCount: 1 });
	});
	it("lets the task parent relay guidance into the child it paused for a run, and refuses another parent", async () => {
		const { fixture } = await pausedFixture();
		fixtures.push(fixture);
		const parent = fixture.bind();
		await parent.send({ type: "set_client_info", capabilities: ["task_parent"] });
		await parent.send({
			type: "pause_for_run",
			parentSessionId: "p",
			parentPauseSeq: 1,
			runRef: { kind: "dag", id: "r1" },
		});

		const relayed = (await parent.send({
			type: "hold_input",
			inputId: "guide-1",
			revision: 0,
			text: "Use the staging database",
			parentSessionId: "p",
			origin: "human",
		})) as { success: boolean; data?: { duplicate?: boolean } };
		const intruder = (await parent.send({
			type: "hold_input",
			inputId: "guide-2",
			revision: 0,
			text: "x",
			parentSessionId: "someone-else",
			origin: "human",
		})) as { success: boolean; error?: string };

		expect(relayed).toMatchObject({ success: true, data: { duplicate: false } });
		expect(intruder.success).toBe(false);
		expect(intruder.error).toContain("wrong_parent");
		expect(fixture.session.pausedHeldInputCount).toBe(1);
	});
	it("pauses a task child for its parent's run and resumes it with the held human input first", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const parent = fixture.bind();
		await parent.send({ type: "set_client_info", capabilities: ["task_parent"] });
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const runRef = { kind: "dag", id: "r1" };
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;

		const paused = (await parent.send({
			type: "pause_for_run",
			parentSessionId: "p",
			parentPauseSeq: 1,
			runRef,
		})) as { data: { childSeq: number } };
		probe.releaseTool();
		await prompt;
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");
		await human.send({ type: "prompt", message: "Use the staging database" });
		await settle(fixture);
		const stale = (await parent.send({
			type: "resume_for_run",
			parentSessionId: "p",
			parentPauseSeq: 0,
			resumeId: "x",
			childSeqCutoff: paused.data.childSeq,
		})) as { data: { released: boolean; reason?: string } };
		expect(fixture.harness.faux.state.callCount).toBe(1);

		const resumed = (await parent.send({
			type: "resume_for_run",
			parentSessionId: "p",
			parentPauseSeq: 1,
			resumeId: "rs-1",
			childSeqCutoff: paused.data.childSeq,
		})) as { data: { released: boolean; turnId?: string } };
		await settle(fixture);

		expect(stale.data).toMatchObject({ released: false, reason: "stale" });
		expect(resumed.data.released).toBe(true);
		expect(resumed.data.turnId).toBeDefined();
		expect(fixture.harness.faux.state.callCount).toBe(2);
		const resumeTurn = JSON.stringify(
			fixture.session.messages.find(
				(message) => message.role === "custom" && Reflect.get(message, "customType") === "session-resumed",
			),
		);
		const heldAt = resumeTurn.indexOf("Use the staging database");
		expect(heldAt).toBeGreaterThan(-1);
		expect(heldAt).toBeLessThan(resumeTurn.indexOf("Synthetic background process finished."));
		expect(resumeTurn.indexOf("Synthetic background process finished.")).toBeLessThan(
			resumeTurn.indexOf("The user stopped the previous turn"),
		);
	});

	it("refuses run pause and resume from a connection that is not the task parent, or from another parent", async () => {
		const { fixture } = await pausedFixture();
		fixtures.push(fixture);
		const stranger = fixture.bind();
		const parent = fixture.bind();
		await parent.send({ type: "set_client_info", capabilities: ["task_parent"] });
		const runRef = { kind: "task", id: "t1" };

		const notParent = (await stranger.send({
			type: "pause_for_run",
			parentSessionId: "p",
			parentPauseSeq: 1,
			runRef,
		})) as { success: boolean; error?: string };
		await parent.send({ type: "pause_for_run", parentSessionId: "p", parentPauseSeq: 1, runRef });
		const other = (await parent.send({ type: "pause_for_run", parentSessionId: "q", parentPauseSeq: 9, runRef })) as {
			success: boolean;
			error?: string;
		};

		expect(notParent.success).toBe(false);
		expect(notParent.error).toContain("task_parent_required");
		expect(other.success).toBe(false);
		expect(other.error).toContain("wrong_parent");
		expect(await state(parent)).toMatchObject({ paused: true });
	});
	it("tells extensions about a Stop, holds run-tagged wakes on a fenced parent, and a message resumes the run", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const changes: Array<{ change: string; kinds: string[] }> = [];
		probe.api?.on("session_hold_changed", (event) => {
			changes.push({ change: event.change, kinds: event.holds.map((hold) => hold.kind) });
		});
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);
		const runRef = { kind: "dag" as const, id: "r1" };
		probe.context?.fenceRun?.(runRef);

		await rpc.send({ type: "prompt", message: "Carry on with the run" });
		await settle(fixture);

		expect(changes[0]).toEqual({ change: "paused", kinds: ["session_hold"] });
		expect(changes.at(-1)?.change).toBe("resumed");
		expect(probe.context?.getPauseState?.().holds).toEqual([]);
		expect(fixture.harness.faux.state.callCount).toBe(2);
	});

	it("keeps a run-tagged wake as a notice while only the run fence is live", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		probe.context?.fenceRun?.({ kind: "task", id: "t1" });
		const outcome = wakeOutcome(fixture);

		probe.api?.sendMessage(
			{
				customType: "senpi-task.completion",
				content: "child finished",
				display: false,
				details: { runRef: { kind: "task", id: "t1" } },
			},
			{ triggerTurn: true },
		);

		expect(await outcome).toBe("notice");
		expect(fixture.harness.faux.state.callCount).toBe(0);
	});
	it("keeps a prompt from a non-interactive connection as a notice; the interactive one releases", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const bot = fixture.bind();
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);

		const botAnswer = (await bot.send({ type: "prompt", message: "Automated nudge" })) as {
			data?: { heldAsNotice?: boolean };
		};
		await settle(fixture);
		expect(botAnswer.data?.heldAsNotice).toBe(true);
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(await state(human)).toMatchObject({ paused: true, pausedNoticeCount: 1 });

		const consumed = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("notice was never consumed")), 5000);
			const off = fixture.session.subscribe((event) => {
				if (event.type !== "session_notice" || event.disposition !== "model_consumed") return;
				clearTimeout(timer);
				off();
				resolve();
			});
		});
		await human.send({ type: "prompt", message: "Carry on" });
		await consumed;
		await settle(fixture);

		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(await state(human)).toMatchObject({ paused: false, pausedNoticeCount: 0 });
		expect(JSON.stringify(fixture.session.messages)).toContain("Automated nudge");
	});
	it("marks a tool call the Stop interrupted, and the resumed turn does not re-run it", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const rpc = fixture.bind();
		await rpc.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = rpc.send({ type: "abort", intent: "stop", awaitIdle: true });
		await Promise.all([prompt, stop]);
		probe.releaseTool();
		await settle(fixture);

		const results = fixture.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(Reflect.get(results[0] ?? {}, "details")).toMatchObject({ interrupted: { pauseSeq: 1 } });
		expect(JSON.stringify(results[0])).toContain("It was not re-run.");

		await fixture.session.resumeSession();
		await settle(fixture);
		expect(fixture.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
	});
	it("keeps every automatic wake producer as a notice after a Stop, one notice per wake", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const bot = fixture.bind();
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);
		const producers = [
			"senpi-terminal:notification",
			"senpi-monitor:event",
			"senpi-terminal:restore-digest",
			"senpi-codemode:notification",
			"goal-continuation",
			"senpi.todo-owed",
			"senpi-loop:tick",
			"senpi.loop-guard.notice",
			"senpi.ttsr.injection",
			"websearch-native-fallback",
			"senpi.hooks.stop-output",
			"senpi-task:completion",
		];

		for (const customType of producers) {
			await fixture.session.sendCustomMessage(
				{ customType, content: `wake from ${customType}`, display: false },
				{ triggerTurn: true },
			);
		}
		await bot.send({
			type: "send_custom_message",
			customType: "external:delivery",
			content: "from another session",
			triggerTurn: true,
		});
		await bot.send({ type: "prompt", message: "scripted nudge" });
		await settle(fixture);

		expect(fixture.harness.faux.state.callCount).toBe(1);
		const notices = fixture.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "session-notice");
		expect(notices).toHaveLength(producers.length + 2);
		expect(await state(human)).toMatchObject({ paused: true });
	});
	it("keeps the notices unconsumed when a second Stop lands during the turn that delivers them", async () => {
		const { fixture, probe, started, release } = await twoStopFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const first = started();
		const prompt = fixture.session.prompt("Work on it");
		await first;
		const firstStop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		release();
		await Promise.all([firstStop, prompt]);
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");

		const second = started();
		const delivering = human.send({ type: "prompt", message: "Carry on" });
		await second;
		const secondStop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		release();
		await Promise.all([secondStop, delivering]);
		await settle(fixture);
		expect(await state(human)).toMatchObject({ paused: true, pausedNoticeCount: 1 });

		const consumed = noticesConsumed(fixture);
		await human.send({ type: "prompt", message: "Now finish" });
		await consumed;
		await settle(fixture);
		expect(await state(human)).toMatchObject({ paused: false, pausedNoticeCount: 0 });
		expect(fixture.harness.faux.state.callCount).toBe(3);
	});
	it("holds a message accepted before a second Stop and admitted after it, instead of releasing the pause", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const firstStop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, firstStop]);
		await settle(fixture);
		let stopDuringPreflight = true;
		probe.api?.on("before_agent_start", () => {
			if (!stopDuringPreflight) return;
			stopDuringPreflight = false;
			void fixture.session.stop();
		});

		await human.send({ type: "prompt", message: "Use the staging database" });
		await settle(fixture);
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(await state(human)).toMatchObject({ paused: true, pausedHeldInputCount: 1 });

		await fixture.session.prompt("Go");
		await settle(fixture);
		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(await state(human)).toMatchObject({ paused: false, pausedHeldInputCount: 0 });
		expect(JSON.stringify(fixture.session.messages)).toContain("Use the staging database");
	});
	it("keeps a question timeout as a notice, and a human answer releases the Stop", async () => {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);
		if (probe.api === undefined || probe.context === undefined) throw new Error("extension binding unavailable");

		const timeout = wakeOutcome(fixture);
		probe.api.sendUserMessage("The question timed out without an answer.", { deliverAs: "followUp" });
		expect(await timeout).toBe("notice");
		expect(fixture.harness.faux.state.callCount).toBe(1);

		const consumed = noticesConsumed(fixture);
		// ask-user's human answer: release the question input, then deliver through the extension API.
		releaseQuestionInput(probe.context);
		probe.api.sendUserMessage("Answer: use staging", { deliverAs: "followUp" });
		await consumed;
		await settle(fixture);

		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(await state(human)).toMatchObject({ paused: false, pausedNoticeCount: 0 });
	});
	async function stoppedWithNotice() {
		const { fixture, probe } = await pausedFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const prompt = fixture.session.prompt("Work on it");
		await probe.toolStarted;
		const stop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		probe.releaseTool();
		await Promise.all([prompt, stop]);
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");
		return { fixture, human };
	}

	type ResumeAnswer = {
		success: boolean;
		error?: string;
		data?: {
			resumed: boolean;
			reason?: string;
			pauseSeq: number;
			turnStarted: boolean;
			deliveredNotices: number;
			deliveredHeldInputs: number;
			replayed?: boolean;
		};
	};

	it("answers stale for an old expectedSeq and changes nothing", async () => {
		const { fixture, human } = await stoppedWithNotice();
		const stale = (await human.send({ type: "resume_session", expectedSeq: 0 })) as ResumeAnswer;
		await settle(fixture);

		expect(stale.data).toMatchObject({ resumed: false, reason: "stale" });
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(await state(human)).toMatchObject({ paused: true, pausedNoticeCount: 1 });
	});

	it("releases without a turn in release mode, so the notice rides the next message", async () => {
		const { fixture, human } = await stoppedWithNotice();
		const pauseSeq = ((await state(human)) as { pause?: { pauseSeq: number } }).pause?.pauseSeq;
		expect(pauseSeq).toBeGreaterThan(0);
		const released = (await human.send({
			type: "resume_session",
			mode: "release",
			...(pauseSeq === undefined ? {} : { expectedSeq: pauseSeq }),
		})) as ResumeAnswer;
		await settle(fixture);

		expect(released.data).toMatchObject({ resumed: true, turnStarted: false });
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(await state(human)).toMatchObject({ paused: false, pausedNoticeCount: 1 });
	});

	it("continues with one turn carrying the message, then the notice, then the directive, and replays an effectId once", async () => {
		const { fixture, human } = await stoppedWithNotice();
		const consumed = noticesConsumed(fixture);
		const first = (await human.send({
			type: "resume_session",
			message: "Use staging",
			effectId: "resume-1",
		})) as ResumeAnswer;
		await consumed;
		await settle(fixture);
		const replay = (await human.send({
			type: "resume_session",
			message: "Use staging",
			effectId: "resume-1",
		})) as ResumeAnswer;
		await settle(fixture);

		expect(first.data).toMatchObject({
			resumed: true,
			turnStarted: true,
			deliveredNotices: 1,
			deliveredHeldInputs: 1,
		});
		expect(replay.data).toMatchObject({ resumed: true, replayed: true });
		expect(fixture.harness.faux.state.callCount).toBe(2);
		const turn = JSON.stringify(
			fixture.session.messages.find(
				(message) => message.role === "custom" && Reflect.get(message, "customType") === "session-resumed",
			),
		);
		expect(turn.indexOf("Use staging")).toBeGreaterThan(-1);
		expect(turn.indexOf("Use staging")).toBeLessThan(turn.indexOf("Synthetic background process finished."));
		expect(turn.indexOf("Synthetic background process finished.")).toBeLessThan(
			turn.indexOf("The user stopped the previous turn"),
		);
		expect(await state(human)).toMatchObject({ paused: false, pausedNoticeCount: 0, pausedHeldInputCount: 0 });
	});

	it("refuses a child's own resume while only its parent's run hold is live", async () => {
		const { fixture } = await pausedFixture();
		fixtures.push(fixture);
		const parent = fixture.bind();
		await parent.send({ type: "set_client_info", capabilities: ["task_parent"] });
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		await parent.send({
			type: "pause_for_run",
			parentSessionId: "p",
			parentPauseSeq: 1,
			runRef: { kind: "dag", id: "r1" },
		});

		const refused = (await human.send({ type: "resume_session" })) as ResumeAnswer & {
			data?: { parentSessionId?: string };
		};

		expect(refused.data).toMatchObject({ resumed: false, reason: "resume_through_parent", parentSessionId: "p" });
		expect(await state(human)).toMatchObject({ paused: true });
	});

	it("answers not_paused when nothing is held", async () => {
		const { fixture } = await pausedFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });

		const answer = (await human.send({ type: "resume_session" })) as ResumeAnswer;

		expect(answer.data).toMatchObject({ resumed: false, reason: "not_paused" });
	});
	it("answers resume_session once the resumed turn is admitted, before that turn settles", async () => {
		const { fixture, probe, started, release } = await twoStopFixture();
		fixtures.push(fixture);
		const human = fixture.bind();
		await human.send({ type: "set_client_info", capabilities: ["interactive_user"] });
		const first = started();
		const prompt = fixture.session.prompt("Work on it");
		await first;
		const stop = human.send({ type: "abort", intent: "stop", awaitIdle: true });
		release();
		await Promise.all([stop, prompt]);
		await settle(fixture);
		expect(await lateTerminalCompletion(fixture, probe)).toBe("notice");

		const resumedToolStarted = started();
		const answer = (await human.send({ type: "resume_session" })) as {
			data?: { resumed: boolean; turnStarted: boolean };
		};
		await resumedToolStarted;

		expect(answer.data).toMatchObject({ resumed: true, turnStarted: true });
		expect(fixture.session.isStreaming).toBe(true);
		release();
		await settle(fixture);
		expect(await state(human)).toMatchObject({ paused: false });
	});
});
