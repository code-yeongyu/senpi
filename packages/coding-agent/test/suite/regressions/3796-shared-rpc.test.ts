// #3796: one real shared handler, several actual writer connections.
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { getMcpGrantPresentation, selectMcpGrant } from "../../../src/core/mcp-grant-presentations.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import type { RpcExtensionUIRequest } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;
let handler: RpcConnectionHandler | undefined;
let writer: SessionEventWriter | undefined;
const routing = "synthetic-routing";
const frames = new Map<string, RpcExtensionUIRequest[]>();
let selected: ((frame: Extract<RpcExtensionUIRequest, { method: "select" }>) => void) | undefined;

afterEach(async () => {
	vi.useRealTimers();
	await handler?.dispose();
	for (const id of frames.keys()) writer?.unregisterConnection(id);
	harness?.cleanup();
	frames.clear();
	selected = undefined;
});

function connect(id: string, capabilities: string[] = []): void {
	if (!writer) throw new Error("writer missing");
	const records: RpcExtensionUIRequest[] = [];
	frames.set(id, records);
	writer.registerConnection(id, {
		writeRaw: (chunk) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				const record: RpcExtensionUIRequest = JSON.parse(line);
				records.push(record);
				if (record.type === "extension_ui_request" && record.method === "select") selected?.(record);
			}
		},
		waitForBackpressure: async () => {},
	});
	writer.setConnectionCapabilities(id, capabilities);
	writer.attachConnectionToSession(id, routing);
}

async function setup(): Promise<Harness> {
	harness = await createHarness();
	writer = new SessionEventWriter(() => {});
	connect("question-only", ["question"]);
	connect("grant-client", ["grant_select"]);
	const runtime = {
		session: harness.session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	const activeWriter = writer;
	handler = createRpcConnectionHandler(
		runtime,
		{
			writeRaw: (chunk) => {
				for (const line of chunk.split("\n").filter(Boolean)) activeWriter.enqueue(routing, JSON.parse(line));
			},
			waitForBackpressure: async () => {},
		},
		{
			sessionId: routing,
			disposeRuntime: false,
			capabilities: ["question"],
			bindSecurityPresentation: (session, ui) =>
				activeWriter.bindSecurityPresentations(routing, session.sessionId, session.securityNotices, ui),
			clientInfo: {
				connectionId: () => activeWriter.currentConnection(),
				setCapabilities: (id, capabilities) => {
					if (id) activeWriter.setConnectionCapabilities(id, capabilities);
				},
				hasCapability: (id, capability) =>
					activeWriter.getConnectionCapabilities(id)?.includes(capability) === true,
			},
		},
	);
	await handler.ready;
	return harness;
}

function nextSelect(): Promise<Extract<RpcExtensionUIRequest, { method: "select" }>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("grant select did not arrive")), 10_000);
		selected = (frame) => {
			selected = undefined;
			clearTimeout(timer);
			resolve(frame);
		};
	});
}

it("replays each notice once per attached connection, including late attach", async () => {
	const current = await setup();
	current.session.securityNotices.add({ category: "skill-link-blocked", message: "synthetic notice" });
	await writer?.flushConnection("question-only");
	await writer?.flushConnection("grant-client");
	const notices = (id: string) => frames.get(id)?.filter((frame) => frame.method === "notify");
	expect(notices("question-only")).toHaveLength(1);
	expect(notices("grant-client")).toHaveLength(1);
	connect("late");
	await writer?.flushConnection("late");
	expect(notices("late")).toHaveLength(1);
	expect(notices("question-only")).toHaveLength(1);
	current.session.securityNotices.add({ category: "skill-link-blocked", message: "synthetic second notice" });
	await writer?.flushConnection("grant-client");
	expect(notices("grant-client")).toHaveLength(3); // full snapshot at the next generation
});

it("targets only grant_select and rejects another connection's answer", async () => {
	const current = await setup();
	const delivered = nextSelect();
	const decision = selectMcpGrant(getMcpGrantPresentation(current.session.sessionId), "synthetic grant");
	const frame = await delivered;
	expect(frames.get("question-only")?.some((record) => record.method === "select")).toBe(false);
	let settled = false;
	void decision.then(() => {
		settled = true;
	});
	await writer?.withConnection("question-only", () =>
		handler?.handleInputLine(
			JSON.stringify({
				type: "extension_ui_response",
				id: frame.id,
				value: "Grant and save permanently",
			}),
		),
	);
	expect(settled).toBe(false);
	// A normal capability heartbeat must not cancel the outstanding decision.
	await writer?.withConnection("grant-client", () =>
		handler?.handleInputLine(
			JSON.stringify({
				type: "set_client_info",
				capabilities: ["grant_select"],
			}),
		),
	);
	expect(settled).toBe(false);
	await writer?.withConnection("grant-client", () =>
		handler?.handleInputLine(
			JSON.stringify({
				type: "extension_ui_response",
				id: frame.id,
				value: "Grant and save permanently",
			}),
		),
	);
	expect(await decision).toBe(true);
});

async function answer(connection: string, frame: Record<string, unknown>): Promise<void> {
	await writer?.withConnection(connection, () =>
		handler?.handleInputLine(
			JSON.stringify({ type: "extension_ui_response", value: "Grant and save permanently", ...frame }),
		),
	);
}

async function pendingGrant(current: Harness) {
	const delivered = nextSelect();
	const decision = selectMcpGrant(getMcpGrantPresentation(current.session.sessionId), "synthetic grant");
	const frame = await delivered;
	const state = { settled: false };
	void decision.then(() => {
		state.settled = true;
	});
	return { frame, decision, state };
}

// #4348: grant answers are matched by the request they answer (uiRequestId ?? id).
it("does not apply a long-form grant answer from a connection without grant_select", async () => {
	const { frame, decision, state } = await pendingGrant(await setup());
	await answer("question-only", { id: "synthetic-answer-a", uiRequestId: frame.id });
	expect(state.settled).toBe(false);
	await answer("grant-client", { id: frame.id });
	expect(await decision).toBe(true);
});

it("does not apply a long-form grant answer from another grant_select connection that did not receive it", async () => {
	const { frame, decision, state } = await pendingGrant(await setup());
	connect("grant-other", ["grant_select"]);
	await writer?.flushConnection("grant-other");
	expect(frames.get("grant-other")?.some((record) => record.method === "select")).toBe(false);
	await answer("grant-other", { id: "synthetic-answer-b", uiRequestId: frame.id });
	expect(state.settled).toBe(false);
	await answer("grant-client", { id: frame.id });
	expect(await decision).toBe(true);
});

it("settles a grant from the short-form answer of the capable recipient", async () => {
	const { frame, decision } = await pendingGrant(await setup());
	await answer("grant-client", { id: frame.id });
	expect(await decision).toBe(true);
});

it("settles a grant from the long-form answer of the capable recipient", async () => {
	const { frame, decision } = await pendingGrant(await setup());
	await answer("grant-client", { id: "synthetic-answer-d", uiRequestId: frame.id });
	expect(await decision).toBe(true);
});

it("expires a capable client that never answers at 120 seconds", async () => {
	const current = await setup();
	vi.useFakeTimers();
	const delivered = nextSelect();
	const decision = selectMcpGrant(getMcpGrantPresentation(current.session.sessionId), "synthetic grant");
	expect((await delivered).timeout).toBe(120_000);
	await vi.advanceTimersByTimeAsync(120_000);
	expect(await decision).toBe(false);
});

it("cancels on disconnect and leaves a question-only client headless", async () => {
	const current = await setup();
	const delivered = nextSelect();
	const decision = selectMcpGrant(getMcpGrantPresentation(current.session.sessionId), "synthetic grant");
	await delivered;
	writer?.unregisterConnection("grant-client");
	expect(await decision).toBe(false);
	expect(getMcpGrantPresentation(current.session.sessionId)).toBeUndefined();
});
