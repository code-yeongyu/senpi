// senpi#5729 (S35 review fold): every await between a hand's epoch check and the moment a call dispatches (or an ack
// lands) is a window in which the new owner's floor can rise. Each row opens one such window, raises the floor inside
// it, and requires the old owner's frame to be fenced: the tool never runs and nothing is recorded as acknowledged.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createExecutionLedger } from "../../src/execution/ledger.ts";
import { createHandEpochFence, HAND_SELF_SENDER } from "../../src/execution/remote-epoch.ts";
import { createRemoteExecutor } from "../../src/execution/remote-executor.ts";
import { createHandLedger } from "../../src/execution/remote-hand-ledger.ts";
import type { RemoteHandMessage, RemoteInvoke } from "../../src/execution/remote-protocol.ts";
import { fakeHandLink } from "./fake-hand-link.ts";

const invoke = (id: string): RemoteInvoke => ({
	kind: "invoke",
	epoch: 1,
	executionId: id,
	batchId: "b",
	index: 0,
	scope: { id: "s", root: "/work/s" },
	toolCallId: id,
	name: "probe",
	arguments: {},
});
const settleMicrotasks = async (): Promise<void> => {
	for (let turn = 0; turn < 64; turn++) await Promise.resolve();
};

async function openHand(options: { readonly ledger: boolean; readonly sequential?: boolean }) {
	const store = openMemoryStore(createMemoryStoreMedium());
	await store.claim(0, 1);
	const admission = createAdmissionLine();
	const ledger = createExecutionLedger({ store, epoch: 1, admission });
	const fence = createHandEpochFence({ ownerOf: () => HAND_SELF_SENDER, durable: { store, epoch: 1, admission } });
	const opening = Promise.withResolvers<void>();
	const bodies = new Map<string, PromiseWithResolvers<void>>();
	const ran: string[] = [];
	const link = fakeHandLink();
	const executor = createRemoteExecutor({
		authority: { kind: "self" },
		transport: link.transport,
		fence,
		...(options.ledger
			? {
					ledger: createHandLedger({
						ledger,
						executor: "hand",
						issuer: "session",
						workspace: "workspace",
						now: () => 1_000,
						leaseMs: 3_600_000,
					}),
				}
			: {}),
		openScope: async () => {
			await opening.promise;
			return {
				run: async (call) => {
					ran.push(call.toolCallId);
					await bodies.get(call.toolCallId)?.promise;
					return { content: [{ type: "text", text: "ran" }], details: {} };
				},
				isSequential: () => options.sequential === true,
				dispose: async () => {},
			};
		},
		onFault: (error) => {
			throw error;
		},
	});
	await executor.ready;
	await link.deliver({ kind: "floor", epoch: 1 }, "s");
	const holdAdmission = (): (() => void) => {
		const held = Promise.withResolvers<void>();
		void admission.admit(() => held.promise);
		return () => held.resolve();
	};
	const outcome = (executionId: string): string => {
		const reply = link.sent.findLast(
			(message: RemoteHandMessage) => "executionId" in message && message.executionId === executionId,
		);
		return reply?.kind === "refused" ? `refused:${reply.reason}` : (reply?.kind ?? "none");
	};
	const untilReply = async (executionId: string): Promise<void> => {
		while (outcome(executionId) === "none") await link.sentCount(link.sent.length + 1);
	};
	const states = async () =>
		(await ledger.scan()).map(({ commandId, progress }) => [
			commandId,
			progress.state === "settled" ? progress.outcome.reason : progress.state,
		]);
	const raise = () => fence.raise("s", 2, HAND_SELF_SENDER);
	const bodyGate = (id: string) => {
		const gate = Promise.withResolvers<void>();
		bodies.set(id, gate);
		return () => gate.resolve();
	};
	return { link, opening, ran, outcome, untilReply, states, raise, holdAdmission, bodyGate };
}

type Hand = Awaited<ReturnType<typeof openHand>>;

interface Window {
	readonly name: string;
	readonly ledger: boolean;
	readonly sequential?: boolean;
	/** Opens the window around the old owner's frame, raises the floor inside it, and closes it. */
	readonly run: (hand: Hand) => Promise<void>;
	readonly outcome: { readonly id: string; readonly reply: string };
	readonly ran: readonly string[];
	readonly states: readonly (readonly string[])[];
}

const WINDOWS: readonly Window[] = [
	{
		name: "no ledger: the floor rises while the call opens its scope",
		ledger: false,
		run: async (hand) => {
			const pending = hand.link.deliver(invoke("e1"));
			await hand.raise();
			hand.opening.resolve();
			await pending;
			await hand.untilReply("e1");
		},
		outcome: { id: "e1", reply: "refused:epoch_fenced" },
		ran: [],
		states: [],
	},
	{
		name: "no ledger: the floor rises while the call waits behind an earlier sequential call",
		ledger: false,
		sequential: true,
		run: async (hand) => {
			const releaseFirst = hand.bodyGate("e0");
			hand.opening.resolve();
			await hand.link.deliver(invoke("e0"));
			await hand.link.deliver(invoke("e1"));
			await hand.raise();
			releaseFirst();
			await hand.untilReply("e1");
		},
		outcome: { id: "e1", reply: "refused:epoch_fenced" },
		ran: ["e0"],
		states: [],
	},
	{
		name: "ledger: the floor rises while the call opens its scope",
		ledger: true,
		run: async (hand) => {
			const pending = hand.link.deliver(invoke("e1"));
			await hand.raise();
			hand.opening.resolve();
			await pending;
		},
		outcome: { id: "e1", reply: "refused:epoch_fenced" },
		ran: [],
		states: [],
	},
	{
		name: "ledger: the floor rises between two steps of the call's walk",
		ledger: true,
		run: async (hand) => {
			hand.opening.resolve();
			const release = hand.holdAdmission();
			const pending = hand.link.deliver(invoke("e1"));
			await settleMicrotasks();
			const raised = hand.raise();
			release();
			await Promise.all([pending, raised]);
		},
		outcome: { id: "e1", reply: "refused:epoch_fenced" },
		ran: [],
		states: [["e1", "cancelled"]],
	},
	{
		name: "ledger: the old owner's invoke passes its check while the floor's raise is queued ahead of it",
		ledger: true,
		run: async (hand) => {
			hand.opening.resolve();
			const release = hand.holdAdmission();
			const raised = hand.raise();
			await settleMicrotasks();
			const pending = hand.link.deliver(invoke("e1"));
			release();
			await Promise.all([pending, raised]);
		},
		outcome: { id: "e1", reply: "refused:epoch_fenced" },
		ran: [],
		states: [],
	},
	{
		name: "ledger: the old owner's ack passes its check while the floor's raise is queued ahead of it",
		ledger: true,
		run: async (hand) => {
			hand.opening.resolve();
			await hand.link.deliver(invoke("e1"));
			await hand.untilReply("e1");
			const release = hand.holdAdmission();
			const raised = hand.raise();
			await settleMicrotasks();
			const acked = hand.link.deliver({ kind: "ack", executionId: "e1", epoch: 1 }, "s");
			release();
			await Promise.all([acked, raised]);
		},
		outcome: { id: "e1", reply: "settled" },
		ran: ["e1"],
		states: [["e1", "result"]],
	},
];

describe("a floor raised in any await between a hand's epoch check and dispatch fences the old owner (S35)", () => {
	it.each(WINDOWS)("$name", async (window) => {
		const hand = await openHand({ ledger: window.ledger, ...(window.sequential ? { sequential: true } : {}) });
		await window.run(hand);
		expect({
			reply: hand.outcome(window.outcome.id),
			ran: hand.ran,
			states: await hand.states(),
		}).toEqual({ reply: window.outcome.reply, ran: window.ran, states: window.states });
	});
});
