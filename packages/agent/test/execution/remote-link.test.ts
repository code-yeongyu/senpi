// senpi#5645 (S40, design C1/C3): a session re-sends waiting calls only to a hand whose `hello` says it is durable,
// waits a bounded time for that `hello` before a file operation is `unsupported`, and reports a hand's terminal
// outcome for a file operation as `interrupted` with its reason and uncertainty.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceFileError, FILE_CHANNEL } from "../../src/execution/device-files.ts";
import { createRemoteDeviceFiles, HELLO_WAIT_MS } from "../../src/execution/remote-device-files.ts";
import { createHandLink } from "../../src/execution/remote-link.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	HAND_CONTROL_LANE,
	type RemoteHandMessage,
	type RemoteInvoke,
} from "../../src/execution/remote-protocol.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

afterEach(() => {
	vi.useRealTimers();
});

function fakeTransport() {
	const sent: RemoteHandMessage[] = [];
	let handler: FrameHandler | undefined;
	const transport: Transport = {
		send: async (_lane, payload) => {
			sent.push(decodeRemoteMessage(payload));
		},
		onFrame: (next) => {
			handler = next;
		},
		inFlight: () => 0,
		close: () => {},
	};
	const deliver = async (lane: string, message: RemoteHandMessage): Promise<void> => {
		await handler?.({ lane, payload: encodeRemoteMessage(message) });
	};
	return { transport, sent, deliver };
}

const scope = { id: "scope-a", root: "/work" };
const invoke: RemoteInvoke = {
	kind: "invoke",
	executionId: "exec-1",
	batchId: "batch",
	index: 0,
	scope,
	toolCallId: "call-1",
	name: "read",
	arguments: {},
};
const hello = (durable: boolean, ops: readonly string[] = []): RemoteHandMessage => ({
	kind: "hello",
	instance: "hand-1",
	durable,
	ops,
});

describe("the session's hand link (senpi#5645, C1/C3)", () => {
	it("re-sends a waiting call only on a durable hand's hello", async () => {
		const { transport, sent, deliver } = fakeTransport();
		const link = createHandLink(transport);
		void link.dispatch(invoke);
		await Promise.resolve();

		await deliver(HAND_CONTROL_LANE, hello(false));
		const afterLedgerless = sent.filter((message) => message.kind === "invoke").length;
		await deliver(HAND_CONTROL_LANE, hello(true));
		const afterDurable = sent.filter((message) => message.kind === "invoke").length;

		expect([afterLedgerless, afterDurable]).toEqual([1, 2]);
		link.close();
	});

	it("answers unsupported, sending nothing, when no hello arrives within the bound", async () => {
		vi.useFakeTimers();
		const { transport, sent } = fakeTransport();
		const files = createRemoteDeviceFiles(createHandLink(transport), scope, () => "exec-2");

		const read = files.read("/work/note.md").catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(HELLO_WAIT_MS);

		expect(await read).toMatchObject({ code: "unsupported" });
		expect(sent).toEqual([]);
	});

	it("reports a terminal outcome as interrupted with the hand's reason and uncertainty", async () => {
		const { transport, deliver } = fakeTransport();
		const files = createRemoteDeviceFiles(createHandLink(transport), scope, () => "exec-3");
		await deliver(HAND_CONTROL_LANE, hello(false, [FILE_CHANNEL]));

		const write = files.write("/work/note.md", new Uint8Array(1)).catch((error: unknown) => error);
		await Promise.resolve();
		await deliver(scope.id, {
			kind: "terminal",
			executionId: "exec-3",
			reason: "hand_restarted",
			uncertain: true,
			hooksRan: true,
		});
		const error = await write;

		expect(error).toBeInstanceOf(DeviceFileError);
		expect(error).toMatchObject({ code: "interrupted", reason: "hand_restarted", uncertain: true });
	});
});
