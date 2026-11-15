// omo-service#997, senpi#6777: a tool call or device file operation still pending when the hand link closes (the hand
// died or was replaced) ends typed, and never runs again. One the hand may have received - its send started, finished
// or not - is a hand restart with its outcome unknown; one that never went out had no effect, and a floor ack arriving
// after the close does not send it.
import { describe, expect, it } from "vitest";
import { DeviceFileError, FILE_CHANNEL } from "../../src/execution/device-files.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	HAND_CONTROL_LANE,
	type RemoteHandMessage,
} from "../../src/execution/remote-protocol.ts";
import { createRemoteToolHost } from "../../src/execution/remote-tool-host.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

/** A transport that tells the test each message kind as it is sent, can hold a kind's send unfinished, and replies. */
function recordingTransport(options: { readonly hold?: RemoteHandMessage["kind"] } = {}) {
	const sent: string[] = [];
	const invoked: string[] = [];
	const waiters = new Map<string, () => void>();
	let handler: FrameHandler | undefined;
	const transport: Transport = {
		send: (_lane, payload) => {
			const message = decodeRemoteMessage(payload);
			const { kind } = message;
			sent.push(kind);
			if (message.kind === "invoke") invoked.push(message.toolCallId);
			waiters.get(kind)?.();
			return kind === options.hold ? new Promise<void>(() => {}) : Promise.resolve();
		},
		onFrame: (next) => {
			handler = next;
		},
		inFlight: () => 0,
		close: () => {},
	};
	return {
		transport,
		sent,
		/** The tool call ids of the invokes sent, in order. */
		invoked,
		/** Resolves when a message of `kind` is handed to the transport (at once if it already was). */
		sending: (kind: string) =>
			new Promise<void>((resolve) => (sent.includes(kind) ? resolve() : waiters.set(kind, resolve))),
		reply: (lane: string, message: RemoteHandMessage) => handler?.({ lane, payload: encodeRemoteMessage(message) }),
	};
}

const scope = { id: "s", root: "/w" };

function runCall(host: ReturnType<typeof createRemoteToolHost>, id = "c") {
	const ended: unknown[] = [];
	const execution = host.execute(
		{ scope, calls: [{ type: "toolCall", id, name: "probe", arguments: {} }], mode: "parallel" },
		{ emit: (event) => void (event.type === "tool_execution_end" && ended.push(event.result)) },
	);
	return { done: execution.then(() => ended[0]) };
}

describe("a remote tool call when the hand link closes", () => {
	it("ends as a hand restart with its outcome unknown once its invoke went out", async () => {
		const wire = recordingTransport();
		const host = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine" });
		const call = runCall(host);
		await wire.sending("invoke");

		host.close();

		expect(await call.done).toMatchObject({
			isError: true,
			details: { outcome: "hand_restarted", uncertain: true, hooksRan: true },
		});
	});

	it("counts an invoke whose send was still unfinished at the close as sent", async () => {
		const wire = recordingTransport({ hold: "invoke" });
		const host = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine" });
		const call = runCall(host);
		await wire.sending("invoke");

		host.close();

		expect(await call.done).toMatchObject({ details: { outcome: "hand_restarted", uncertain: true } });
	});

	it("ends as cancelled when its invoke never went out, and a floor ack after the close never sends it", async () => {
		const wire = recordingTransport();
		const host = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine", epoch: 2 });
		const call = runCall(host);
		await wire.sending("floor");

		host.close();
		const result = await call.done;
		// A later call on the same lane waits on the same floor. Once the ack opens the lane, its invoke goes out after
		// every send the ack released, the closed call's included, so seeing it proves the closed call sent nothing.
		const later = runCall(host, "later");
		await wire.reply("s", { kind: "floor_ack", floor: 2 });
		await wire.sending("invoke");

		expect(result).toMatchObject({
			isError: true,
			details: { outcome: "cancelled", uncertain: false, hooksRan: false },
		});
		expect(wire.invoked).toEqual(["later"]);
		host.close();
		await later.done;
	});

	it("ends as the non-error placeholder under split-local placement, as the session's own recovery decides", async () => {
		const wire = recordingTransport();
		const host = createRemoteToolHost({ transport: wire.transport, placement: "split-local" });
		const call = runCall(host);
		await wire.sending("invoke");

		host.close();

		expect(await call.done).toMatchObject({ isError: false });
	});
});

/** The hand's hello, serving the file channel: a device file operation waits for it before it is sent. */
const announceFiles = (wire: ReturnType<typeof recordingTransport>) =>
	wire.reply(HAND_CONTROL_LANE, { kind: "hello", instance: "hand-1", durable: false, ops: [FILE_CHANNEL] });

describe("a device file operation when the hand link closes (#6778 review L1)", () => {
	it("is interrupted with its outcome uncertain once it was sent, never reported as never having happened", async () => {
		const wire = recordingTransport();
		const host = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine" });
		await announceFiles(wire);
		const write = host.deviceFiles(scope).write("/w/a.txt", new TextEncoder().encode("x"));
		await wire.sending("file");

		host.close();

		const error = await write.then(
			() => undefined,
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(DeviceFileError);
		expect(error).toMatchObject({ code: "interrupted", reason: "hand_restarted", uncertain: true });
	});

	it("is hand_unreachable when it never went out", async () => {
		const wire = recordingTransport();
		const host = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine", epoch: 2 });
		await announceFiles(wire);
		const write = host.deviceFiles(scope).write("/w/a.txt", new TextEncoder().encode("x"));
		await wire.sending("floor");

		host.close();

		await expect(write).rejects.toMatchObject({ code: "hand_unreachable", uncertain: false });
	});
});
