import { expect, it } from "vitest";
import { contextHost } from "./rpc-session-context-support.ts";

function browserStates(inbox: readonly Record<string, unknown>[], sessionId: string): unknown[] {
	return inbox
		.filter((record) => record.type === "extension_event" && record.name === "omo.browser.state")
		.filter((record) => record.sessionId === sessionId)
		.map((record) => record.data);
}

it("delivers a skill's browser state to the client as that session's own extension_event", async () => {
	await using host = await contextHost({ browserStateExtension: true });
	await host.send("conn-a", { type: "set_client_info", width: 80, capabilities: ["extension_events"] });
	const first = String((await host.open("conn-a", { browserEngine: "connected" })).sessionId);
	const second = String((await host.open("conn-a", { browserEngine: "builtin" })).sessionId);

	await host.callTool(first, "browser_state_probe", { state: "attached" });
	await host.callTool(second, "browser_state_probe", { state: "idle" });

	const inbox = host.inbox("conn-a");
	expect(browserStates(inbox, first)).toEqual([{ state: "attached" }]);
	expect(browserStates(inbox, second)).toEqual([{ state: "idle" }]);
}, 120_000);

it("sends nothing to a client that did not advertise extension_events", async () => {
	await using host = await contextHost({ browserStateExtension: true });
	await host.send("conn-a", { type: "set_client_info", width: 80, capabilities: [] });
	const session = String((await host.open("conn-a", { browserEngine: "connected" })).sessionId);

	await host.callTool(session, "browser_state_probe", { state: "attached" });

	expect(browserStates(host.inbox("conn-a"), session)).toEqual([]);
}, 120_000);
