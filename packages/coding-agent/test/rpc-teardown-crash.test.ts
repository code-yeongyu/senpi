import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type AbortAndFireQueuedMessagesThis = {
	clearAllQueues: () => { steering: string[]; followUp: string[]; ordered?: Array<{ text: string }> };
	updatePendingMessagesDisplay: () => void;
	editor: { getText: () => string; setText: (text: string) => void };
	session: { abort: () => Promise<void> };
};

describe("RPC teardown when the transport is gone", () => {
	test("abort after the socket is gone does not reject", async () => {
		const client = new RpcClient();
		(client as any).sessionId = "session";

		await expect(client.abort()).resolves.toBeUndefined();
	});

	test("the Esc abort helper does not reject when the socket is gone", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "abortAndFireQueuedMessages");
		const abortAndFireQueuedMessages = descriptor?.value as (this: AbortAndFireQueuedMessagesThis) => Promise<number>;
		const fakeThis: AbortAndFireQueuedMessagesThis = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			editor: { getText: () => "", setText: vi.fn() },
			session: { abort: () => new RpcClient().abort() },
		};

		await expect(abortAndFireQueuedMessages.call(fakeThis)).resolves.toBe(0);
	});

	test("active send failures still surface", async () => {
		const client = new RpcClient();

		await expect(client.prompt("active turn")).rejects.toMatchObject({
			name: "RpcTransportGoneError",
			code: "rpc_transport_gone",
		});
	});
});
