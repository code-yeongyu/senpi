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
import { decodePlaneMessage, encodePlaneMessage, type PlaneMessage } from "../../src/execution/plane.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

/** A transport that tells the test each message kind as it is sent, can hold a kind's send unfinished, and replies. */
function recordingTransport(options: { readonly hold?: RemoteHandMessage["kind"] } = {}) {
	const sent: string[] = [];
	const invoked: string[] = [];
	const waiters = new Map<string, () => void>();
	const handlers: FrameHandler[] = [];
	const transport: Transport = {
		send: (_lane, payload) => {
			const plane = decodePlaneMessage(payload);
			const message = plane === undefined ? decodeRemoteMessage(payload) : undefined;
			const kind = plane?.kind ?? message?.kind ?? "unknown";
			sent.push(kind);
			if (message?.kind === "invoke") invoked.push(message.toolCallId);
			waiters.get(kind)?.();
			return kind === options.hold ? new Promise<void>(() => {}) : Promise.resolve();
		},
		onFrame: (next) => {
			handlers.push(next);
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
		sending: (kind: string, count = 1) =>
			new Promise<void>((resolve) => {
				const check = () => sent.filter((sentKind) => sentKind === kind).length >= count;
				if (check()) return resolve();
				waiters.set(kind, () => check() && resolve());
			}),
		/** Delivers one frame to every link on this transport, in the order they attached, in one synchronous pass. */
		reply: (lane: string, message: RemoteHandMessage | PlaneMessage) => {
			const payload = message.kind.startsWith("plane.")
				? encodePlaneMessage(message as PlaneMessage)
				: encodeRemoteMessage(message as RemoteHandMessage);
			for (const handler of handlers) void handler({ lane, payload });
		},
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
		const closed = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine", epoch: 2 });
		const open = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine", epoch: 2 });
		const call = runCall(closed);
		await wire.sending("floor");
		// A second, open link waits on its own floor for the same lane, attached after the closed one.
		const later = runCall(open, "later");
		await wire.sending("floor", 2);

		closed.close();
		const result = await call.done;
		// One ack frame reaches both links in attach order, in one synchronous pass: the closed call's continuation is
		// queued first, so by the time the open link's invoke is seen it has already run, and it sent nothing.
		wire.reply("s", { kind: "floor_ack", floor: 2 });
		await wire.sending("invoke");

		expect(result).toMatchObject({
			isError: true,
			details: { outcome: "cancelled", uncertain: false, hooksRan: false },
		});
		expect(wire.invoked).toEqual(["later"]);
		open.close();
		await later.done;
	});

	it("settles a call made after close() at once as cancelled, and sends nothing (#6785 review L2)", async () => {
		const wire = recordingTransport();
		const host = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine" });
		host.close();

		const call = runCall(host);
		const outcome = await Promise.race([call.done, wire.sending("invoke").then(() => "sent on a closed link")]);

		expect(outcome).toMatchObject({
			isError: true,
			details: { outcome: "cancelled", uncertain: false, hooksRan: false },
		});
		expect(wire.sent).toEqual([]);
	});

	it("writes nothing for frames that arrive after close(): no ack, no floor re-send on a hello, no plane.refused (#6791 L1, #6796 L1)", async () => {
		const wire = recordingTransport();
		const host = createRemoteToolHost({ transport: wire.transport, placement: "cross-machine", epoch: 2 });
		const call = runCall(host);
		await wire.sending("floor");
		wire.reply("s", { kind: "floor_ack", floor: 2 });
		await wire.sending("invoke");
		const before = [...wire.sent];

		host.close();
		await call.done;
		wire.reply("s", { kind: "settled", executionId: "late", result: { content: [], details: {}, isError: false } });
		wire.reply(HAND_CONTROL_LANE, { kind: "hello", instance: "restarted", durable: true, ops: [] });
		wire.reply("s", { kind: "plane.request", parent: "late", childRequestId: "r1", plane: "probe", body: null });
		// A frame's handler hands its writes to the transport synchronously, so every write it would make is recorded now.

		expect(before).toEqual(["floor", "invoke"]);
		expect(wire.sent).toEqual(before);
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
