import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { stopHoldLive } from "../../../src/core/extensions/builtin/goal/stop-pause.ts";
import { createGoal, readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { sessionHeld, userStopped } from "../../../src/core/extensions/builtin/loop/session-hold.ts";
import type { ExtensionContext, SessionHoldRecord } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { resumeCommandTarget } from "../../../src/modes/interactive/pause-footer.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function reopenedSession(
	options: { interrupted?: boolean; goal?: boolean; consumed?: boolean; unattended?: boolean } = {},
) {
	const delivery = Promise.withResolvers<void>();
	const errors: string[] = [];
	let providerCalls = 0;
	const extensionFactories: HarnessOptions["extensionFactories"] = [
		...(options.goal ? [goalExtension] : []),
		(pi) => {
			pi.on("session_start", (event) => {
				if (event.reason !== "resume" || options.goal) return;
				pi.sendMessage(
					{ customType: "senpi-monitor:restart", content: "Automatic continuation", display: false },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			});
		},
	];
	const h = await createHarness({ extensionFactories });
	cleanups.push(h.cleanup);
	const servicesFor = (h: Harness): AgentSessionServices => ({
		cwd: h.tempDir,
		agentDir: h.tempDir,
		authStorage: h.authStorage,
		modelRegistry: h.modelRegistry,
		modelRuntime: h.session.modelRuntime,
		settingsManager: h.settingsManager,
		resourceLoader: h.session.resourceLoader,
		diagnostics: [],
	});
	const services = servicesFor(h);
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const fresh = await createHarness({
			siblingOf: h,
			extensionFactories,
			sessionManager,
			sessionStartEvent: {
				type: "session_start",
				reason: "resume",
				...sessionStartEvent,
				attended: options.unattended !== true,
			},
		});
		const stream = fresh.session.agent.streamFunction;
		fresh.session.agent.streamFunction = (...args) => {
			providerCalls++;
			return stream(...args);
		};
		cleanups.push(fresh.cleanup);
		return {
			session: fresh.session,
			services: servicesFor(fresh),
			diagnostics: [],
			extensionsResult: fresh.session.resourceLoader.getExtensions(),
		};
	};
	const runtime = new AgentSessionRuntime(h.session, services, factory);
	cleanups.push(() => runtime.dispose());
	runtime.setRebindSession(async (session) => {
		session.subscribe((event) => {
			if (event.type === "session_notice" || event.type === "agent_idle") delivery.resolve();
		});
		await session.bindExtensions({
			mode: options.unattended ? "rpc" : "tui",
			onError: (error) => {
				errors.push(error.error);
				delivery.resolve();
			},
		});
	});
	const saved = SessionManager.create(h.tempDir, join(h.tempDir, "saved"));
	saved.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
	saved.appendMessage(fauxAssistantMessage("Previous answer"));
	if (options.consumed)
		saved.appendCustomEntry("work-custody", {
			sessionId: saved.getSessionId(),
			id: "consumed-delivery",
			key: "delivery:interrupted",
			kind: "background",
			state: "consumed",
			ticketId: "interrupted-ticket",
			runId: "interrupted-run",
		});
	else if (options.interrupted !== false)
		saved.appendCustomEntry("session-lifecycle", {
			sessionId: saved.getSessionId(),
			state: "running",
			seq: 2,
			epoch: 1,
			epochOrigin: "human",
			humanInputRevision: 1,
			selfSettleEligible: true,
			runPaused: false,
			since: "2026-10-24T00:00:00.000Z",
			role: "root",
			rootSessionId: saved.getSessionId(),
			persisted: true,
			runActive: true,
			epochSealed: false,
			runId: "interrupted-run",
		});
	if (options.goal) await createGoal(goalStoreRef(saved, h.tempDir), "Finish the original request");
	const file = saved.getSessionFile();
	if (!file) throw new Error("Missing saved session");
	h.setResponses([fauxAssistantMessage("Recovered")]);
	// This is the session switch and extension rebind used by the /resume picker.
	expect(await runtime.switchSession(file)).toEqual({ cancelled: false });
	await delivery.promise;
	return { runtime, h, errors, providerCalls: () => providerCalls };
}

it.each([
	{ action: "resume", consumed: false },
	{ action: "input", consumed: false },
	{ action: "resume", consumed: true },
	{ action: "input", consumed: true },
])("holds a reopened interrupted session until $action (consumed: $consumed)", async ({ action, consumed }) => {
	const fixture = await reopenedSession({ consumed });
	const session = fixture.runtime.session;
	expect(fixture.errors).toEqual([]);
	expect(fixture.providerCalls()).toBe(0);
	expect(session.paused).toBe(true);
	expect(session.pausedNoticeCount).toBe(1);
	expect(session.lifecycle.state).toBe("waiting_human");
	expect(resumeCommandTarget(session)).toBe("resume_session");
	expect(session.lifecycle.waitingOn?.human).toEqual(
		expect.arrayContaining([expect.objectContaining({ kind: "interrupted_run" })]),
	);
	expect(
		session.messages.some((message) => message.role === "custom" && message.customType === "senpi-monitor:restart"),
	).toBe(false);

	if (action === "resume") await session.resumeSession();
	else await session.prompt("Continue the original request");

	expect(fixture.errors).toEqual([]);
	expect(fixture.providerCalls()).toBe(1);
	expect(session.messages.some((message) => getMessageText(message).includes("Automatic continuation"))).toBe(true);
	expect(session.paused).toBe(false);
	expect(session.pausedNoticeCount).toBe(0);
	expect(session.lifecycle.waitingOn?.human?.some((wait) => wait.kind === "interrupted_run")).not.toBe(true);
});

it("does not queue or count an active goal continuation before interrupted recovery", async () => {
	const fixture = await reopenedSession({ goal: true });
	const session = fixture.runtime.session;
	expect(fixture.errors).toEqual([]);
	expect(fixture.providerCalls()).toBe(0);
	expect(session.paused).toBe(true);
	expect(session.lifecycle.state).toBe("waiting_human");
	expect(
		session.messages.some((message) => message.role === "custom" && message.customType === "goal-continuation"),
	).toBe(false);
	expect((await readGoal(goalStoreRef(session.sessionManager, fixture.h.tempDir)))?.unattendedContinuations).toBe(0);
});

it("still delivers session-start automation when the previous run was not interrupted", async () => {
	const fixture = await reopenedSession({ interrupted: false });
	expect(fixture.errors).toEqual([]);
	expect(fixture.providerCalls()).toBe(1);
	expect(fixture.runtime.session.paused).toBe(false);
});

it("reports unattended interrupted recovery as held", async () => {
	const fixture = await reopenedSession({ unattended: true });
	expect(fixture.runtime.session.lifecycle).toMatchObject({
		state: "held",
		waitingOn: { human: [expect.objectContaining({ kind: "interrupted_run" })] },
	});
	expect(fixture.providerCalls()).toBe(0);
});

it("accepts ordinary RPC input without imposing user Stop authority on interrupted recovery", async () => {
	const fixture = await reopenedSession();
	const file = fixture.runtime.session.sessionManager.getSessionFile();
	if (!file) throw new Error("Missing reopened session file");
	fixture.runtime.releaseSessionHold();
	const rpcFixture = await createIdentityHarness({
		siblingOf: fixture.h,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: { type: "session_start", reason: "resume" },
	});
	cleanups.push(rpcFixture.cleanup);
	const rpc = rpcFixture.bind();
	await rpc.handler.ready;
	expect(rpcFixture.session.lifecycle).toMatchObject({
		state: "waiting_human",
		waitingOn: { human: expect.arrayContaining([expect.objectContaining({ kind: "interrupted_run" })]) },
	});
	rpcFixture.harness.setResponses([fauxAssistantMessage("Recovered through RPC")]);
	const before = rpcFixture.harness.faux.state.callCount;
	const response = await rpc.send({ type: "prompt", message: "Continue the original request" });
	expect(response).toMatchObject({ success: true, data: { disposition: "started" } });
	await Promise.all(rpc.handler.pendingPrompts());
	expect(rpcFixture.harness.faux.state.callCount - before).toBe(1);
	expect(rpcFixture.session.paused).toBe(false);
	expect(rpcFixture.session.lifecycle.waitingOn?.human?.some((wait) => wait.kind === "interrupted_run")).not.toBe(
		true,
	);
});

it("preserves a genuine Stop's precedence over the interruption gate", async () => {
	const fixture = await reopenedSession();
	const session = fixture.runtime.session;
	await session.stop();
	expect(session.lifecycle.state).toBe("paused");
	await session.resumeSession();
	const directive = session.messages.find(
		(message) => message.role === "custom" && message.customType === "session-resumed",
	);
	expect(directive).toBeDefined();
	expect(directive).not.toHaveProperty("details.resumeCause", "interrupted");
});

it.each(["resume", "input"])("attributes %s recovery to interruption rather than user Stop", async (action) => {
	const fixture = await reopenedSession();
	const session = fixture.runtime.session;
	if (action === "resume") await session.resumeSession();
	else await session.prompt("Continue the original request");
	expect(session.messages).toContainEqual(
		expect.objectContaining({
			role: "custom",
			customType: "session-resumed",
			details: expect.objectContaining({ resumeCause: "interrupted" }),
		}),
	);
});

for (const [name, stopped] of [
	["goal", stopHoldLive],
	["loop", userStopped],
] as const) {
	it.each([
		{ keys: ["interrupted-run"], expected: false },
		{ keys: ["session_hold"], expected: true },
		{ keys: ["interrupted-run", "session_hold"], expected: true },
	])(`${name} keeps automatic work held without attributing $keys to Stop`, ({ keys, expected }) => {
		const ctx = {
			getPauseState: () => ({
				pauseSeq: 1,
				holds: keys.map((key): SessionHoldRecord => ({ kind: "session_hold", key })),
			}),
		} as ExtensionContext;
		expect(sessionHeld(ctx)).toBe(true);
		expect(stopped(ctx)).toBe(expected);
	});
}
