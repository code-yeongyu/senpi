// omo-service#997: a tool call still pending when the hand link closes (the hand died or was replaced) ends as a typed
// terminal, never a generic link error, and never runs again: a call the hand may have received is a hand restart with
// its outcome unknown; one it never received had no effect.
import { describe, expect, it } from "vitest";
import { decodeRemoteMessage } from "../../src/execution/remote-protocol.ts";
import { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import type { Transport } from "../../src/transport/transport.ts";

async function closedCall(options: { readonly epoch?: number }) {
	const sent: string[] = [];
	const transport: Transport = {
		send: async (_lane, payload) => void sent.push(decodeRemoteMessage(payload).kind),
		onFrame: () => {},
		inFlight: () => 0,
		close: () => {},
	};
	const host = createRemoteToolHost({ transport, placement: "cross-machine", ...options });
	const ended: unknown[] = [];
	const execution = host.execute(
		{
			scope: { id: "s", root: "/w" },
			calls: [{ type: "toolCall", id: "c", name: "probe", arguments: {} }],
			mode: "parallel",
		},
		{ emit: (event) => void (event.type === "tool_execution_end" && ended.push(event.result)) },
	);
	for (let turn = 0; turn < 16; turn++) await Promise.resolve();
	host.close();
	await execution;
	return { sent, result: ended[0] };
}

describe("a remote tool call when the hand link closes", () => {
	it("ends as a hand restart with its outcome unknown once its invoke went out", async () => {
		const { sent, result } = await closedCall({});

		expect(sent).toEqual(["invoke"]);
		expect(result).toMatchObject({
			isError: true,
			details: { outcome: "hand_restarted", uncertain: true, hooksRan: true },
		});
	});

	it("ends as cancelled with no effect when its invoke never went out (the floor was never acked)", async () => {
		const { sent, result } = await closedCall({ epoch: 2 });

		expect(sent).toEqual(["floor"]);
		expect(result).toMatchObject({
			isError: true,
			details: { outcome: "cancelled", uncertain: false, hooksRan: false },
		});
	});
});
