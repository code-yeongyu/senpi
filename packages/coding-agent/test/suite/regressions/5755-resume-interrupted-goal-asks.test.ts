import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createGoal, readGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

// senpi#5755: a session whose process died mid-turn keeps its goal `active`. Resuming it must ask, exactly as for
// a goal a clean quit stopped (#5754), before any goal continuation runs.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OBJECTIVE = "Finish the original request";

async function resumeKilledGoalSession(choice: "Resume goal" | "Leave stopped", open: "resume" | "startup" = "resume") {
	const prompts: Array<{ title: string; options: string[] }> = [];
	let providerCalls = 0;
	const uiContext = createTestUiContext({
		select: async (title, options) => {
			prompts.push({ title, options });
			return choice;
		},
	});
	const h = await createHarness({ extensionFactories: [goalExtension] });
	cleanups.push(h.cleanup);
	const servicesFor = (harness: Harness): AgentSessionServices => ({
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		authStorage: harness.authStorage,
		modelRegistry: harness.modelRegistry,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	});
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
		const fresh = await createHarness({
			siblingOf: h,
			extensionFactories: [goalExtension],
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume", ...sessionStartEvent },
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
	const runtime = new AgentSessionRuntime(h.session, servicesFor(h), factory);
	cleanups.push(() => runtime.dispose());
	runtime.setRebindSession(async (session) => {
		await session.bindExtensions({ mode: "tui", uiContext });
	});

	// The saved session of a process killed mid-turn: its last run is still `running` and its goal is still active.
	const saved = SessionManager.create(h.tempDir, join(h.tempDir, "saved"));
	saved.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
	saved.appendMessage(fauxAssistantMessage("Working on it"));
	saved.appendCustomEntry("session-lifecycle", {
		sessionId: saved.getSessionId(),
		state: "running",
		seq: 2,
		epoch: 1,
		epochOrigin: "human",
		humanInputRevision: 1,
		selfSettleEligible: true,
		runPaused: false,
		since: "2026-11-05T00:00:00.000Z",
		role: "root",
		rootSessionId: saved.getSessionId(),
		persisted: true,
		runActive: true,
		epochSealed: false,
		runId: "killed-run",
	});
	await createGoal(goalStoreRef(saved, h.tempDir), OBJECTIVE);
	const file = saved.getSessionFile();
	if (!file) throw new Error("Missing saved session");
	h.setResponses(Array.from({ length: 12 }, (_, index) => fauxAssistantMessage(`Reply ${index + 1}`)));

	let session = runtime.session;
	if (open === "resume") {
		// The /resume picker's session switch and extension rebind.
		expect(await runtime.switchSession(file)).toEqual({ cancelled: false });
		session = runtime.session;
	} else {
		// A launch that opens the saved session (`--continue`, `--session`): a startup, not a switch.
		const launched = await createHarness({
			siblingOf: h,
			extensionFactories: [goalExtension],
			sessionManager: SessionManager.open(file),
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		cleanups.push(launched.cleanup);
		const stream = launched.session.agent.streamFunction;
		launched.session.agent.streamFunction = (...args) => {
			providerCalls++;
			return stream(...args);
		};
		await launched.session.bindExtensions({ mode: "tui", uiContext });
		session = launched.session;
	}
	const goal = () => readGoal(goalStoreRef(session.sessionManager, h.tempDir));
	const continuations = () =>
		session.messages.filter((message) => message.role === "custom" && message.customType === "goal-continuation")
			.length;
	return { session, prompts, goal, continuations, providerCalls: () => providerCalls };
}

it("asks before continuing an active goal whose run was interrupted, and Leave stopped keeps it stopped", async () => {
	const fixture = await resumeKilledGoalSession("Leave stopped");
	expect(fixture.prompts).toEqual([
		{ title: `Resume blocked goal?\nGoal: ${OBJECTIVE}`, options: ["Resume goal", "Leave stopped"] },
	]);
	expect(fixture.providerCalls()).toBe(0);
	expect(await fixture.goal()).toMatchObject({ status: "blocked" });

	await fixture.session.prompt("What is the status?");
	await fixture.session.waitForIdle();

	// The person's message gets its own answer, followed by no hidden goal continuation.
	expect(fixture.providerCalls()).toBe(1);
	expect(fixture.continuations()).toBe(0);
	expect(await fixture.goal()).toMatchObject({ status: "blocked" });
});

it("continues the goal when the person chooses Resume goal", async () => {
	const fixture = await resumeKilledGoalSession("Resume goal");
	expect(fixture.prompts).toHaveLength(1);
	expect(fixture.prompts[0]?.title).toBe(`Resume blocked goal?\nGoal: ${OBJECTIVE}`);
	expect(await fixture.goal()).toMatchObject({ status: "active" });
	// The interrupted run is still the session's to resume (senpi#4683): nothing runs until the person does.
	expect(fixture.providerCalls()).toBe(0);

	await fixture.session.resumeSession();
	await fixture.session.waitForIdle();

	expect(fixture.continuations()).toBeGreaterThan(0);
	expect(fixture.providerCalls()).toBeGreaterThan(0);
});

it("asks the same way when the killed session is opened at launch instead of through /resume", async () => {
	const fixture = await resumeKilledGoalSession("Leave stopped", "startup");
	expect(fixture.providerCalls()).toBe(0);

	await fixture.session.prompt("What is the status?");
	await fixture.session.waitForIdle();

	expect({ providerCalls: fixture.providerCalls(), continuations: fixture.continuations() }).toEqual({
		providerCalls: 1,
		continuations: 0,
	});
	expect(fixture.prompts).toEqual([
		{ title: `Resume blocked goal?\nGoal: ${OBJECTIVE}`, options: ["Resume goal", "Leave stopped"] },
	]);
	expect(await fixture.goal()).toMatchObject({ status: "blocked" });
});
