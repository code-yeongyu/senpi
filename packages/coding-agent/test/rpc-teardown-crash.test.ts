import { describe, expect, test, vi } from "vitest";
import { RemoteInteractiveRuntime } from "../src/modes/interactive/interactive-host-runtime.ts";
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

	test("dispose continues through stop and local dispose after closeSession fails", async () => {
		const client = new RpcClient();
		(client as any).sessionId = "session";
		const stop = vi.spyOn(client, "stop").mockResolvedValue(undefined);
		const localDispose = vi.fn(async () => {});
		const abortLocalBash = vi.fn();
		const runtime = new RemoteInteractiveRuntime({ dispose: localDispose } as any, { abortLocalBash } as any, client);

		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(localDispose).toHaveBeenCalledTimes(1);
		expect(abortLocalBash).toHaveBeenCalledTimes(1);
	});

	test("active send failures still surface", async () => {
		const client = new RpcClient();

		await expect(client.prompt("active turn")).rejects.toThrow("Client not started");
	});
});
