/**
 * N3: a `list_sessions` row's `activity` (`idle`, `running`, `awaiting_approval`, `queued`, `errored`), the
 * `error_code` of an errored last turn and the `turn_id` of the current or most recent turn, read from the
 * same runtime the session's `session_status` row is derived from.
 */
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { controlData } from "../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../helpers/session-control-fixture.ts";
import { createHarness } from "./harness.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "./rpc-session-status-support.ts";

type Host = Awaited<ReturnType<typeof statusHost>>;

const QUESTION: QuestionRequest = {
	requestId: "n3-question",
	questions: [
		{ id: "q1", header: "Pick", question: "Which?", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
	],
	waitForAnswer: true,
	timeoutMs: 60_000,
};

/** A turn that ends with a structured `auth` provider failure, which no retry or fallback takes over. */
function failedTurn(): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "rejected" }),
		providerDiagnostic: { category: "auth", httpStatus: 401, evidence: "structured_status" },
	};
}

async function openSession(client: RawClient): Promise<string> {
	return String(dataOf(await client.request({ type: "open_session" })).sessionId);
}

async function listedRow(client: RawClient, sessionId: string): Promise<WireRecord> {
	const rows = dataOf(await client.request({ type: "list_sessions" })).sessions as WireRecord[];
	const row = rows.find((candidate) => candidate.sessionId === sessionId);
	if (row === undefined) throw new Error(`no list_sessions row for ${sessionId}: ${JSON.stringify(rows)}`);
	return row;
}

function statusOf(subscriptionId: string, sessionId: string, match: (record: WireRecord) => boolean) {
	return (record: WireRecord): boolean =>
		record.type === "session_status" &&
		record.subscriptionId === subscriptionId &&
		record.sessionId === sessionId &&
		match(record);
}

function heldTurn(host: Host): { release: () => void } {
	let release = (): void => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	host.faux.setResponses([
		async () => {
			await held;
			return fauxAssistantMessage("released", { timestamp: 1 });
		},
	]);
	return { release };
}

async function promptToIdle(host: Host, client: RawClient, sessionId: string, message: string): Promise<unknown> {
	const idle = (record: WireRecord) => record.type === "agent_idle" && record.sessionId === sessionId;
	const seen = client.inbox.filter(idle).length;
	const settled = client.waitFor((record) => idle(record) && client.inbox.filter(idle).length > seen);
	const turnId = dataOf(await client.request({ type: "prompt", sessionId, message })).turnId;
	await settled;
	await host.writer.flush();
	return turnId;
}

async function startHeldTurn(client: RawClient, subscriptionId: string, sessionId: string): Promise<unknown> {
	const turnId = dataOf(await client.request({ type: "prompt", sessionId, message: "hold the turn" })).turnId;
	await client.waitFor(statusOf(subscriptionId, sessionId, (record) => record.status === "running"));
	return turnId;
}

async function subscribe(client: RawClient): Promise<string> {
	return String(dataOf(await client.request({ type: "subscribe_sessions" })).subscriptionId);
}

it("lists a session with no turn as idle, and after a completed turn as idle with that turn's id", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const sessionId = await openSession(owner);
	const fresh = await listedRow(owner, sessionId);
	expect(fresh.activity).toBe("idle");
	expect(fresh).not.toHaveProperty("turn_id");
	expect(fresh).not.toHaveProperty("error_code");

	host.faux.setResponses([fauxAssistantMessage("done", { timestamp: 1 })]);
	const turnId = await promptToIdle(host, owner, sessionId, "complete a turn");
	expect(typeof turnId).toBe("string");
	const settled = await listedRow(owner, sessionId);
	expect(settled).toMatchObject({ activity: "idle", turn_id: turnId });
	expect(settled).not.toHaveProperty("error_code");
}, 120_000);

it("lists a session with a held turn as running", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const subscriptionId = await subscribe(owner);
	const sessionId = await openSession(owner);
	const { release } = heldTurn(host);
	const idle = owner.waitFor((record) => record.type === "agent_idle" && record.sessionId === sessionId);
	await startHeldTurn(owner, subscriptionId, sessionId);
	const row = await listedRow(owner, sessionId);
	expect(row.activity).toBe("running");
	expect(row).not.toHaveProperty("error_code");
	release();
	await idle;
}, 120_000);

it("lists the running turn's id while it is in flight, the id the prompt response named", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const subscriptionId = await subscribe(owner);
	const sessionId = await openSession(owner);
	const { release } = heldTurn(host);
	const idle = owner.waitFor((record) => record.type === "agent_idle" && record.sessionId === sessionId);
	const turnId = await startHeldTurn(owner, subscriptionId, sessionId);
	expect(typeof turnId).toBe("string");
	expect(await listedRow(owner, sessionId)).toMatchObject({ activity: "running", turn_id: turnId });
	release();
	await idle;
}, 120_000);

it("lists a session with a pending question as awaiting_approval, and idle once it is withdrawn", async () => {
	await using host = await statusHost({ capabilities: ["question"] });
	const owner = host.client("owner");
	const subscriptionId = await subscribe(owner);
	const sessionId = await openSession(owner);
	const session = host.core.peekSession(sessionId)?.runtime?.session;
	if (session === undefined) throw new Error("no live session");
	const withdraw = new AbortController();
	const asked = session.extensionRunner.getUIContext().question?.(QUESTION, { signal: withdraw.signal });
	if (asked === undefined) throw new Error("the session's UI context raises no question");
	await owner.waitFor(statusOf(subscriptionId, sessionId, (record) => record.status === "waiting_input"));
	expect((await listedRow(owner, sessionId)).activity).toBe("awaiting_approval");

	withdraw.abort();
	await asked;
	expect((await listedRow(owner, sessionId)).activity).toBe("idle");
}, 120_000);

it("lists a running session holding a follow-up as queued", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const subscriptionId = await subscribe(owner);
	const sessionId = await openSession(owner);
	const { release } = heldTurn(host);
	await startHeldTurn(owner, subscriptionId, sessionId);
	host.faux.setResponses([fauxAssistantMessage("follow-up answered", { timestamp: 2 })]);
	dataOf(await owner.request({ type: "follow_up", sessionId, message: "after this turn" }));
	await owner.waitFor(
		statusOf(
			subscriptionId,
			sessionId,
			(record) => (record.pendingQueue as { followUp?: unknown } | undefined)?.followUp === 1,
		),
	);
	expect((await listedRow(owner, sessionId)).activity).toBe("queued");

	const drained = owner.waitFor(
		statusOf(
			subscriptionId,
			sessionId,
			(record) =>
				record.status === "idle" && (record.pendingQueue as { followUp?: unknown } | undefined)?.followUp === 0,
		),
	);
	release();
	await drained;
}, 120_000);

it("lists a session whose last turn failed as errored with the failure's code, until a turn completes", async () => {
	await using host = await statusHost();
	const owner = host.client("owner");
	const sessionId = await openSession(owner);
	host.faux.setResponses([failedTurn()]);
	const failedId = await promptToIdle(host, owner, sessionId, "this turn fails");
	expect(await listedRow(owner, sessionId)).toMatchObject({
		activity: "errored",
		error_code: "auth",
		turn_id: failedId,
	});

	host.faux.setResponses([fauxAssistantMessage("recovered", { timestamp: 2 })]);
	const nextId = await promptToIdle(host, owner, sessionId, "this turn completes");
	expect(nextId).not.toBe(failedId);
	const recovered = await listedRow(owner, sessionId);
	expect(recovered).toMatchObject({ activity: "idle", turn_id: nextId });
	expect(recovered).not.toHaveProperty("error_code");
}, 120_000);

const endpoints: EndpointFixture[] = [];
afterEach(async () => {
	for (const fixture of endpoints.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

it("the terminal control endpoint's row carries the same errored activity, error_code and turn_id", async () => {
	const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
	const fixture = await startEndpoint({ harness });
	endpoints.push(fixture);
	const idleRow = await controlData(fixture.socket, { type: "list_sessions" });
	expect(idleRow).toMatchObject({ sessions: [{ activity: "idle" }] });

	harness.setResponses([failedTurn()]);
	await harness.session.prompt("this turn fails");
	await harness.session.agent.waitForIdle();
	const turnId = String(harness.session.externalAdmission.turnEpoch);
	expect(await controlData(fixture.socket, { type: "list_sessions" })).toMatchObject({
		sessions: [{ activity: "errored", error_code: "auth", turn_id: turnId }],
	});
}, 120_000);
