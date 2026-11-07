/**
 * X5 (plan row P0-03d): today's `get_state` projection, pinned through the real RPC connection
 * handler and a real `AgentSession` (faux provider, no network). `buildRpcSessionState` is the one
 * wire projection of a session, so these pins guard every surface that answers through it.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { nextSessionEvent, runToAgentIdle } from "../suite/lifecycle-test-harness.ts";
import { createIdentityHarness } from "../suite/rpc-client-identity-harness.ts";

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
type Client = ReturnType<Fixture["bind"]>;
type WireState = Record<string, unknown>;

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup();
});

/** Today's key set of an idle, freshly bound session after the JSON wire drops `undefined` values. */
const IDLE_KEYS = [
	"answeredUiRequests",
	"autoCompactionEnabled",
	"contextUsage",
	"cwd",
	"fastMode",
	"favoriteModels",
	"followUp",
	"followUpMode",
	"holds",
	"isBashRunning",
	"isCompacting",
	"isStreaming",
	"lifecycle",
	"messageCount",
	"model",
	"ordered",
	"pause",
	"paused",
	"pausedHeldInputCount",
	"pausedNoticeCount",
	"pendingDialogs",
	"pendingMessageCount",
	"pendingModelSwitch",
	"pendingQuestions",
	"projectTrusted",
	"retryAttempt",
	"runPaused",
	"scopedModels",
	"sessionFile",
	"sessionId",
	"sessionModelThinkingLevels",
	"steering",
	"steeringMode",
	"thinkingLevel",
	"thinkingLevelSource",
	"usageTotals",
];

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

function withoutDeliveryStamp(state: WireState): WireState {
	const { observedAt, ...lifecycle } = state.lifecycle as Record<string, unknown>;
	expect(observedAt).toMatch(ISO_INSTANT);
	return { ...state, lifecycle };
}

async function boundClient(): Promise<{ fixture: Fixture; client: Client }> {
	const fixture = await createIdentityHarness();
	fixtures.push(fixture);
	await fixture.session.bindExtensions({ mode: "rpc" });
	return { fixture, client: fixture.bind() };
}

async function readState(client: Client): Promise<WireState> {
	const response = await client.send({ type: "get_state" });
	expect(response).toMatchObject({ type: "response", command: "get_state", success: true });
	return response.data as WireState;
}

function sessionMirror(session: AgentSession): WireState {
	return {
		lifecycle: wire(session.lifecycle),
		model: wire(session.model),
		thinkingLevel: session.thinkingLevel,
		thinkingLevelSource: session.thinkingLevelSource,
		contextUsage: wire(session.getContextUsage()),
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		autoCompactionEnabled: session.autoCompactionEnabled,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		cwd: session.sessionManager.getCwd(),
		usageTotals: wire(session.sessionManager.getUsageTotals()),
	};
}

describe("X5: get_state projection", () => {
	it("projects a freshly bound idle session with today's exact keys and values", async () => {
		const { fixture, client } = await boundClient();

		const state = await readState(client);

		expect(Object.keys(state).sort()).toEqual(IDLE_KEYS);
		expect(state.lifecycle).not.toHaveProperty("runId");
		expect(withoutDeliveryStamp(state)).toEqual({
			...sessionMirror(fixture.session),
			answeredUiRequests: [],
			paused: false,
			pausedNoticeCount: 0,
			holds: [],
			pendingDialogs: [],
			pendingQuestions: [],
			pendingModelSwitch: null,
			sessionModelThinkingLevels: wire(fixture.session.getSessionModelThinkingLevels()),
			fastMode: false,
			isStreaming: false,
			pausedHeldInputCount: 0,
			runPaused: false,
			pause: wire(fixture.session.pauseView),
			isCompacting: false,
			retryAttempt: 0,
			isBashRunning: false,
			projectTrusted: false,
			steering: [],
			followUp: [],
			ordered: [],
			messageCount: 0,
			pendingMessageCount: 0,
			favoriteModels: [],
			scopedModels: [],
		});
	});

	it("projects the settled transcript after one completed turn", async () => {
		const { fixture, client } = await boundClient();
		fixture.harness.setResponses([fauxAssistantMessage("Done.")]);

		await runToAgentIdle(fixture, () => client.send({ type: "prompt", message: "Do one thing." }));
		const state = await readState(client);

		const start = client.messages().find((record) => record.type === "agent_start");
		expect(start).toMatchObject({ runId: expect.any(String) });
		expect(state.lifecycle).toHaveProperty("runId", start?.runId);
		expect(withoutDeliveryStamp(state)).toMatchObject({
			...sessionMirror(fixture.session),
			isStreaming: false,
			messageCount: 2,
			pendingMessageCount: 0,
			pendingModelSwitch: null,
			steering: [],
			followUp: [],
			ordered: [],
		});
		expect(state).not.toHaveProperty("entries");
		expect(state).not.toHaveProperty("lastAbortSource");
	});

	it("projects a streaming turn live, then keeps the user abort owner after it settles", async () => {
		const { fixture, client } = await boundClient();
		fixture.harness.setResponses([fauxAssistantMessage("streaming response ".repeat(4_000))]);
		const streamStarted = nextSessionEvent(
			fixture,
			(event) => event.type === "message_update" && event.message.role === "assistant",
		);
		const running = fixture.session.prompt("Hold the stream open.");
		await streamStarted;

		expect(await readState(client)).toMatchObject({ isStreaming: true, messageCount: 1 });

		const ended = client.waitFor((record) => record.type === "agent_end", 10_000);
		await client.send({ type: "abort" });
		await running.catch(() => {});
		await ended;

		const settled = await readState(client);
		expect(settled).toMatchObject({ isStreaming: false, lastAbortSource: "user" });
		expect(settled.messageCount).toBe(fixture.session.messages.length);
	});

	it("answers get_state and get_snapshot.state with the same projection", async () => {
		const { client } = await boundClient();

		const state = await readState(client);
		const snapshot = await client.send({ type: "get_snapshot", tail: 0 });

		expect(snapshot).toMatchObject({ command: "get_snapshot", success: true });
		expect(withoutDeliveryStamp((snapshot.data as { state: WireState }).state)).toEqual(withoutDeliveryStamp(state));
	});
});
