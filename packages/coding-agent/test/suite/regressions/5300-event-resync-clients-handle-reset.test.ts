import { PROTOCOL_VERSION, parseClientMessage } from "@earendil-works/pi-protocol";
import { describe, expect, it } from "vitest";
import { ATTACH_CLIENT_CAPABILITIES } from "../../../src/modes/interactive/attach.ts";
import { type RpcClientEvent, RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";

// senpi#5300 (RULING-116): a compact recovery cut sends `message_tool_arguments_reset` (senpi#5298), so an in-repo
// client may advertise `event_resync` only once it handles that record.

const RESET = { type: "message_tool_arguments_reset", contentIndex: 1, rawArgumentPrefix: "", parsedThrough: 0 };

function expectSafe(client: string, advertised: readonly string[], handlesReset: boolean): void {
	if (advertised.includes(EVENT_RESYNC_CAPABILITY))
		expect(handlesReset, `${client} advertises event_resync without handling message_tool_arguments_reset`).toBe(
			true,
		);
}

type RpcClientInternals = {
	send: (command: { type: string; capabilities?: string[] }) => Promise<unknown>;
	handleLine: (line: string) => void;
};

async function rpcClientAdvertises(capabilities?: string[]): Promise<readonly string[]> {
	const sent: { capabilities?: string[] }[] = [];
	const client = new RpcClient() as unknown as RpcClientInternals;
	client.send = async (command) => {
		sent.push(command);
		return { type: "response", command: command.type, success: true };
	};
	await (client as unknown as RpcClient).setClientInfo(80, capabilities);
	return sent[0]?.capabilities ?? [];
}

describe("an in-repo client advertising event_resync handles message_tool_arguments_reset", () => {
	it("TUI attach-client: has no reset handler, so it must not advertise event_resync", () => {
		expectSafe("TUI attach-client", ATTACH_CLIENT_CAPABILITIES, false);
	});

	it("RpcClient: adds no capability of its own and delivers the reset to its typed listeners", async () => {
		expect(await rpcClientAdvertises()).toEqual([]);
		expect(await rpcClientAdvertises(["question"])).toEqual(["question"]);
		const client = new RpcClient();
		const received: RpcClientEvent[] = [];
		client.onEvent((event) => void received.push(event));
		(client as unknown as RpcClientInternals).handleLine(JSON.stringify(RESET));
		const handlesReset = received.some((event) => event.type === "message_tool_arguments_reset");
		expect(handlesReset).toBe(true);
		expectSafe("RpcClient", await rpcClientAdvertises(), handlesReset);
	});

	it("packages/client: its framed hello carries no capability list, so it cannot advertise event_resync", () => {
		expect(parseClientMessage({ type: "hello", version: PROTOCOL_VERSION })).toEqual({
			type: "hello",
			version: PROTOCOL_VERSION,
		});
		expect(() =>
			parseClientMessage({ type: "hello", version: PROTOCOL_VERSION, capabilities: [EVENT_RESYNC_CAPABILITY] }),
		).toThrow();
	});
});
