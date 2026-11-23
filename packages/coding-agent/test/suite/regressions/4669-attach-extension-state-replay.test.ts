/**
 * senpi#4669: a client that attaches to an already-open, idle session on a shared host gets the extensions'
 * current state for itself, as a fresh subscriber does. The subscription the session already holds replayed
 * that state only once, at its own start, so a later attacher saw nothing until the next state change.
 */
import { expect, it } from "vitest";
import { EXTENSION_RPC_SUBSCRIBED_CHANNEL, type ExtensionRpcEvent } from "../../../src/core/event-bus.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { parkClaimHost } from "../rpc-park-claim-support.ts";

function stateExtension(pi: ExtensionAPI): void {
	pi.events.on(EXTENSION_RPC_SUBSCRIBED_CHANNEL, (reply) => {
		if (typeof reply === "function")
			(reply as (event: ExtensionRpcEvent) => void)({ name: "state", data: { jobs: 0 } });
	});
	pi.on("session_start", () => pi.rpc?.emit("live-only", { once: true }));
}

const extensionEvents = (records: readonly Record<string, unknown>[], connection: string) =>
	records.filter((record) => record.type === "extension_event" && record.connection === connection);

async function openThenAttach(observerCapabilities: string[]) {
	const host = await parkClaimHost([stateExtension]);
	await host.request({ type: "set_client_info", width: 120, capabilities: ["extension_events"] });
	const opened = await host.request({ type: "open_session", cwd: host.cwd });
	if (opened.command !== "open_session" || !opened.success) throw new Error("open failed");
	const sessionId = opened.data.sessionId;
	await host.request({ type: "set_client_info", width: 120, capabilities: observerCapabilities }, "observer");
	const ownerBefore = extensionEvents(host.records, "owner").length;
	const attached = await host.request(
		{ type: "attach_session", sessionId, durableSessionId: opened.data.state.sessionId },
		"observer",
	);
	expect(attached).toMatchObject({ success: true, data: { sessionId, attached: true } });
	await host.writer.flush();
	return { host, sessionId, ownerBefore };
}

it("replays the current extension state to an idle attacher only, without a later transition", async () => {
	const { host, sessionId, ownerBefore } = await openThenAttach(["extension_events"]);
	await using _host = host;
	expect(extensionEvents(host.records, "owner").map((record) => record.name)).toEqual(
		expect.arrayContaining(["state", "live-only"]),
	);
	expect(extensionEvents(host.records, "observer")).toEqual([
		expect.objectContaining({ sessionId, name: "state", data: { jobs: 0 } }),
	]);
	expect(extensionEvents(host.records, "owner")).toHaveLength(ownerBefore);
});

it("sends nothing to an attacher that does not take extension events", async () => {
	const { host } = await openThenAttach([]);
	await using _host = host;
	expect(extensionEvents(host.records, "observer")).toEqual([]);
});
