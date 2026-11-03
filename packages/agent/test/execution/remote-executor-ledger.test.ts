// senpi#5482 (S27a): a hand with a durable record writes nothing for a call it refuses, reports a failed recovery to
// onFault, and never resumes a frozen call with other arguments than the ones it froze.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import type { DurableStore, StoreWritePoint } from "../../src/durable/store.ts";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createExecutionLedger } from "../../src/execution/ledger.ts";
import { createRemoteExecutor, type HandScope, type OpenHandScope } from "../../src/execution/remote-executor.ts";
import { createHandLedger, type HandLedger } from "../../src/execution/remote-hand-ledger.ts";
import {
	decodeRemoteMessage,
	encodeRemoteMessage,
	type RemoteHandMessage,
	type RemoteInvoke,
} from "../../src/execution/remote-protocol.ts";
import type { FrameHandler, Transport } from "../../src/transport/transport.ts";

const DISPATCH_COMMIT = 5;

function fakeTransport() {
	const sent: RemoteHandMessage[] = [];
	const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
	let handler: FrameHandler | undefined;
	const transport: Transport = {
		send: async (_lane, payload) => {
			sent.push(decodeRemoteMessage(payload));
			for (const waiter of waiters) if (sent.length >= waiter.count) waiter.resolve();
		},
		onFrame: (next) => {
			handler = next;
		},
		inFlight: () => 0,
		close: () => {},
	};
	const deliver = async (message: RemoteHandMessage): Promise<void> => {
		if (handler === undefined) throw new Error("no frame handler");
		const lane = message.kind === "invoke" ? message.scope.id : "hand.control";
		await handler({ lane, payload: encodeRemoteMessage(message) });
	};
	const sentCount = (count: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ count, resolve });
		if (sent.length >= count) resolve();
		return promise;
	};
	return { transport, sent, deliver, sentCount };
}

const invoke = (args: unknown): RemoteInvoke => ({
	kind: "invoke",
	executionId: "e1",
	batchId: "b1",
	index: 0,
	scope: { id: "s", root: "/work/s" },
	toolCallId: "c1",
	name: "probe",
	arguments: args,
});

const handLedger = (store: DurableStore): HandLedger =>
	createHandLedger({
		ledger: createExecutionLedger({ store, epoch: 1, admission: createAdmissionLine() }),
		executor: "hand",
		issuer: "session",
		workspace: "workspace",
		now: () => 1_000,
		leaseMs: 3_600_000,
	});

async function claimed(medium: MemoryStoreMedium, onWritePoint?: (point: StoreWritePoint) => void) {
	const store = openMemoryStore(medium, onWritePoint === undefined ? {} : { onWritePoint });
	await store.claim(0, 1);
	return store;
}

const rows = (medium: MemoryStoreMedium) =>
	createExecutionLedger({ store: openMemoryStore(medium), epoch: 1, admission: createAdmissionLine() }).scan();

function startHand(store: DurableStore, openScope: OpenHandScope, ledger = handLedger(store)) {
	const link = fakeTransport();
	const faults: unknown[] = [];
	const executor = createRemoteExecutor({
		transport: link.transport,
		openScope,
		ledger,
		onFault: (error) => faults.push(error),
	});
	return { ...link, faults, executor };
}

const recording =
	(bodies: unknown[]): OpenHandScope =>
	async () =>
		({
			run: async (call) => {
				bodies.push(call.arguments);
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
			isSequential: () => false,
			dispose: async () => {},
		}) satisfies HandScope;

const unopenable: OpenHandScope = async () => {
	throw new Error("root is gone");
};

describe("remote executor with a durable record", () => {
	it("writes no record for a call whose scope cannot open", async () => {
		const medium = createMemoryStoreMedium();
		const hand = startHand(await claimed(medium), unopenable);
		await hand.executor.ready;
		await hand.deliver(invoke({ id: 1 }));
		expect(await rows(medium)).toEqual([]);
	});

	it("refuses a re-delivered call whose scope still cannot open", async () => {
		const hand = startHand(await claimed(createMemoryStoreMedium()), unopenable);
		await hand.executor.ready;
		await hand.deliver(invoke({ id: 1 }));
		await hand.deliver(invoke({ id: 1 }));
		expect(hand.sent.filter((message) => message.kind === "refused")).toEqual([
			{ kind: "refused", executionId: "e1", reason: "scope_unavailable: root is gone" },
			{ kind: "refused", executionId: "e1", reason: "scope_unavailable: root is gone" },
		]);
	});

	it("reports a failed recovery to onFault and answers no frame after it", async () => {
		const store = await claimed(createMemoryStoreMedium());
		const failure = new Error("record unreadable");
		const ledger: HandLedger = { ...handLedger(store), recover: async () => Promise.reject(failure) };
		const hand = startHand(store, recording([]), ledger);
		await hand.deliver(invoke({ id: 1 }));
		expect([hand.faults, hand.sent]).toEqual([[failure], []]);
	});

	it.each([
		{ resent: { id: 1 }, outcome: "runs the frozen call once", sent: "settled", bodies: [{ id: 1 }] },
		{ resent: { id: 2 }, outcome: "refuses other arguments", sent: "refused", bodies: [] },
	])("a call frozen before a kill at dispatch $outcome after the restart", async ({ resent, sent, bodies }) => {
		const medium = createMemoryStoreMedium();
		let commit = -1;
		const killed = await claimed(medium, (point) => {
			if (point.op === "commit" && point.at === "before" && ++commit === DISPATCH_COMMIT)
				throw new Error("hand killed before dispatch");
		});
		const first = startHand(killed, recording([]));
		await first.executor.ready;
		await first.deliver(invoke({ id: 1 }));
		const ran: unknown[] = [];
		const restarted = startHand(openMemoryStore(medium), recording(ran));
		await restarted.executor.ready;
		await restarted.deliver(invoke(resent));
		await restarted.sentCount(2);
		expect([first.faults.length, restarted.sent.map(({ kind }) => kind), ran]).toEqual([1, ["hello", sent], bodies]);
	});
});
