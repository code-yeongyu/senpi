/**
 * senpi#4669: a client that attaches to an already-open, idle session on a shared host gets the extensions'
 * current state for itself, as a fresh subscriber does, decided by its own `extension_events` declaration.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EXTENSION_RPC_SUBSCRIBED_CHANNEL } from "../../../src/core/event-bus.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import type { WireRecord } from "./4272-worker-acceptance-support.ts";

const EVENTS = ["extension_events"];
const COMPACT = ["compact_message_updates_v1", "event_resync"];

afterEach(() => vi.unstubAllEnvs());

const named = (inbox: readonly WireRecord[], name: string) =>
	inbox.filter((record) => record.type === "extension_event" && record.name === name);

async function openedSession(ownerCapabilities: string[], compact = false) {
	const host = await statusHost();
	const owner = host.client("owner");
	await owner.request({ type: "set_client_info", capabilities: ownerCapabilities });
	const opened = await owner.request({
		type: "open_session",
		cwd: host.cwd,
		...(compact ? { admissionId: "owner" } : {}),
	});
	const sessionId = String(compact ? opened.sessionId : dataOf(opened).sessionId);
	const rows = dataOf(await owner.request({ type: "list_sessions" })).sessions as {
		sessionId: string;
		durableSessionId: string;
	}[];
	const durableSessionId = rows.find((row) => row.sessionId === sessionId)?.durableSessionId ?? "";
	const pi = host.extensionApis.get(durableSessionId);
	if (!pi?.events) throw new Error("session extension API missing");
	pi.events.on(EXTENSION_RPC_SUBSCRIBED_CHANNEL, (reply) => {
		if (typeof reply === "function") reply({ name: "toy_state", data: { jobs: 1 } });
	});
	pi.rpc?.emit("toy_live", { once: true });
	await host.writer.flush();
	return { host, owner, sessionId, durableSessionId };
}

it("replays to an idle attacher that declared extension events even when the opener did not", async () => {
	const { host, owner, sessionId, durableSessionId } = await openedSession([]);
	await using _host = host;
	const observer = host.client("observer");
	await observer.request({ type: "set_client_info", capabilities: EVENTS });
	expect(await observer.request({ type: "attach_session", sessionId, durableSessionId })).toMatchObject({
		success: true,
	});
	await host.writer.flush();
	expect(named(observer.inbox, "toy_state")).toEqual([expect.objectContaining({ sessionId, data: { jobs: 1 } })]);
	expect(named(observer.inbox, "toy_live")).toEqual([]);
	expect(named(owner.inbox, "toy_state")).toEqual([]);
});

it("sends nothing to an attacher that did not declare extension events", async () => {
	const { host, owner, sessionId, durableSessionId } = await openedSession(EVENTS);
	await using _host = host;
	const ownerStates = named(owner.inbox, "toy_state").length;
	const observer = host.client("observer");
	await observer.request({ type: "attach_session", sessionId, durableSessionId });
	await host.writer.flush();
	expect(observer.inbox.filter((record) => record.type === "extension_event")).toEqual([]);
	expect(named(owner.inbox, "toy_state")).toHaveLength(ownerStates);
});

it("queues a compact attacher's replay only after its admission answered", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const { host, sessionId, durableSessionId } = await openedSession(COMPACT, true);
	await using _host = host;
	const observer = host.client("observer");
	await observer.request({ type: "set_client_info", capabilities: [...COMPACT, ...EVENTS] });
	const attached = await observer.request({
		type: "attach_session",
		sessionId,
		durableSessionId,
		admissionId: "attach",
	});
	expect(attached).toMatchObject({ success: true, admissionId: "attach" });
	await host.writer.flush();
	const state = named(observer.inbox, "toy_state");
	expect(state).toHaveLength(1);
	expect(observer.inbox.indexOf(state[0])).toBeGreaterThan(observer.inbox.indexOf(attached));
});

it("drops a queued replay whose attachment was released before it was written", async () => {
	const { host, sessionId, durableSessionId } = await openedSession([]);
	await using _host = host;
	const drained = Promise.withResolvers<void>();
	let stalled = false;
	const observer = host.client("observer", {
		waitForBackpressure: () => (stalled ? drained.promise : Promise.resolve()),
	});
	await observer.request({ type: "set_client_info", capabilities: EVENTS });
	stalled = true;
	const send = (command: Record<string, unknown>) =>
		host.writer.withConnection("observer", () => host.core.handle(JSON.stringify(command)));
	await send({ id: "attach", type: "attach_session", sessionId, durableSessionId });
	await send({ id: "release", type: "release_attachment", sessionId });
	stalled = false;
	drained.resolve();
	await host.writer.flush();
	expect(observer.inbox.some((record) => record.type === "response" && record.id === "release")).toBe(true);
	expect(named(observer.inbox, "toy_state")).toEqual([]);
});
