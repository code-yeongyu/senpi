import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeResult } from "../../../src/core/agent-session-runtime.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const registries: RpcSessionRegistry[] = [];
afterEach(async () => {
	for (const registry of registries.splice(0)) {
		for (const row of registry.list()) await registry.close(row.sessionId);
	}
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});

// senpi#3853: drive the real router and registry into a faux-provider AgentSession, not a launch-profile mock.
it("open_session attended:false holds an active goal, and a subsequent attach releases nothing", async () => {
	const a = await createHarness({ persistSession: true, extensionFactories: [goalExtension] });
	harnesses.push(a);
	await a.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	a.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Keep working" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Goal ready")]),
	]);
	await a.session.prompt("set a goal");
	const sessionPath = a.sessionManager.getSessionFile()!;
	a.session.dispose();
	let resumed: Harness | undefined;
	const registry = new RpcSessionRegistry({
		agentDir: a.session.agentDir,
		createRuntime: async (options) => {
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			resumed = await createHarness({
				siblingOf: a,
				cwd: options.cwd,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				extensionFactories: [goalExtension],
			});
			harnesses.push(resumed);
			return {
				session: resumed.session,
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	});
	registries.push(registry);
	const router = new SessionCommandRouter(
		registry,
		new SessionEventWriter(() => {}),
		{ cwd: a.session.cwd },
		async (_sessionId, entry) => {
			await entry.runtime!.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
			return { handle: async () => {}, dispose: async () => {} };
		},
	);
	const before = a.faux.state.callCount;
	await router.handle({ type: "open_session", sessionPath, attended: false });
	if (!resumed) throw new Error("router did not open the session");
	expect(a.faux.state.callCount).toBe(before);
	expect(buildRpcSessionState(resumed.session)).toMatchObject({
		paused: true,
		pausedNoticeCount: 1,
		holds: [
			{ kind: "session_hold", key: "interrupted-run", since: expect.any(String), sourceCounts: { goal: 1 } },
			{ kind: "unattended", since: expect.any(String), sourceCounts: { goal: 1 } },
		],
		lifecycle: {
			state: "held",
			waitingOn: { human: expect.arrayContaining([expect.objectContaining({ kind: "interrupted_run" })]) },
		},
	});
	await router.handle({ type: "open_session", sessionPath });
	expect(a.faux.state.callCount).toBe(before);
	expect(resumed.session.paused).toBe(true);
});

it.each([true, "false", 0, null])("refuses invalid attended value %s before opening", async (attended) => {
	const openSession = vi.fn();
	const router = new SessionCommandRouter(
		{ openSession } as unknown as RpcSessionRegistry,
		new SessionEventWriter(() => {}),
		{ cwd: process.cwd() },
	);
	const response = await router.handle({ type: "open_session", attended } as unknown as Parameters<
		SessionCommandRouter["handle"]
	>[0]);
	expect(response).toMatchObject({ success: false, error: expect.stringContaining("invalid_launch_profile") });
	expect(openSession).not.toHaveBeenCalled();
});

it("resume_session releases held sources through the real RPC command handler", async () => {
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(h);
	const runtime = {
		session: h.session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	const chunks: string[] = [];
	const handler = createRpcConnectionHandler(runtime, {
		writeRaw: (chunk) => {
			chunks.push(chunk);
		},
		waitForBackpressure: async () => {},
	});
	try {
		await handler.ready;
		await h.session.sendCustomMessage(
			{ customType: "senpi-codemode:notification", content: "completed", display: false },
			{ triggerTurn: true },
		);
		expect(h.faux.state.callCount).toBe(0);
		h.setResponses([fauxAssistantMessage([fauxText("resumed")])]);
		const settled = Promise.withResolvers<void>();
		const unsubscribe = h.session.subscribe((event) => {
			if (event.type === "agent_idle" && h.faux.state.callCount === 1) settled.resolve();
		});
		await handler.handleInputLine(JSON.stringify({ id: "resume", type: "resume_session" }));
		await settled.promise;
		unsubscribe();
		const records = chunks
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "resume", type: "response", command: "resume_session", success: true }),
				expect.objectContaining({ type: "session_resumed", cause: "resume_session" }),
			]),
		);
		expect(h.session.paused).toBe(false);
		expect(h.faux.state.callCount).toBe(1);
	} finally {
		await handler.dispose();
	}
});
