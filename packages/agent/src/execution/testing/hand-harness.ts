import type { AgentToolCall, AgentToolResult, ToolExecutionMode } from "../../types.ts";
import { createAdmissionLine } from "../../durable/store-admission.ts";
import type { DurableStore, StoreWritePoint } from "../../durable/store.ts";
import { createManualTimers, type ManualTimers } from "../../durable/testing/manual-timers.ts";
import { claimedStore } from "../../durable/testing/store-cases.ts";
import type { StoreCaseAdapters } from "../../durable/testing/store-harness.ts";
import { createInProcessNetwork } from "../../transport/in-process-carrier.ts";
import { localEndpoint } from "../../transport/local-endpoint.ts";
import type { CarrierFault, TransportCaseAdapters } from "../../transport/testing/transport-harness.ts";
import type { CarrierSide, TransportSide } from "../../transport/transport.ts";
import { createExecutionLedger } from "../ledger.ts";
import type { ExecutionEntry } from "../ledger-types.ts";
import type { PlaneHandler } from "../plane.ts";
import { createRemoteExecutor, type HandCall, type HandScope } from "../remote-executor.ts";
import { createHandLedger } from "../remote-hand-ledger.ts";
import { createRemoteToolHost, type HandPlacement } from "../remote-tool-host.ts";
import type { ToolHostResult } from "../tool-host.ts";

/** What the KILL-HAND, MULTI-HAND and FAULT-HAND cases need from a host: a durable store and a transport. */
export type HandCaseAdapters = StoreCaseAdapters & TransportCaseAdapters;

/** Kill the hand at the `commit`-th ledger commit (0-based), before it or once it is durable. */
export interface KillPoint {
	readonly commit: number;
	readonly at: "before" | "durable";
}

export interface HandRig {
	/** Every tool body start, as `<scope>:<toolCallId>`, across all hand processes. */
	readonly bodies: readonly string[];
	/** Faults the hand processes reported (a killed hand reports the kill). */
	readonly faults: readonly unknown[];
	readonly killed: Promise<void>;
	execute(scope: string, calls: readonly AgentToolCall[], mode?: ToolExecutionMode): Promise<ToolHostResult>;
	/** Kills the hand process now, wherever its calls are (a body waiting on the session included): it writes nothing more. */
	kill(): void;
	/** A new hand process on the reopened store and the same link; resolves once it announced itself. */
	restart(): Promise<void>;
	/** Hold every body until `release(toolCallId)`. */
	gateBodies(): void;
	release(toolCallId: string): void;
	/**
	 * Lets `ms` of transport time pass in small steps, running the work each due timer starts before the next step, so a
	 * check made afterwards sees everything that time could have produced. Cases wait only through this, `settle` and
	 * `runUntil`: a bare timer advance fires timers without letting the hand's settle chain run, and an assertion that
	 * nothing happened would then pass whether or not the case's precondition held.
	 */
	advance(ms: number): Promise<void>;
	/** Advances transport time until `promise` settles; fails past the budget. */
	settle<T>(promise: Promise<T>, what: string, budgetMs?: number): Promise<T>;
	runUntil(done: () => boolean, what: string, budgetMs?: number): Promise<void>;
	/** Drops the carrier between session and hand (the hand becomes unreachable) and attaches it again. */
	disconnect(): void;
	reconnect(): void;
	rows(): Promise<ExecutionEntry[]>;
}

const TICK_MS = 5;
const LEASE_MS = 3_600_000;
const drain = async (): Promise<void> => {
	for (let turn = 0; turn < 32; turn++) await Promise.resolve();
};

export function call(id: string): AgentToolCall {
	return { type: "toolCall", id, name: "probe", arguments: { id } };
}

export type TransportPump = Pick<HandRig, "advance" | "settle" | "runUntil">;

/** Steps transport time on `timers` the way every hand rig waits (see {@link HandRig.advance}). */
export function transportPump(timers: ManualTimers): TransportPump {
	const pump = async (stop: () => boolean, ms: number): Promise<void> => {
		const end = timers.now() + ms;
		await drain();
		while (!stop() && timers.now() < end) {
			await timers.advanceTo(Math.min(end, timers.now() + TICK_MS));
			await drain();
		}
	};
	const runUntil = async (done: () => boolean, what: string, budgetMs = 600_000): Promise<void> => {
		await pump(done, budgetMs);
		if (!done()) throw new Error(`${what}: not reached within ${budgetMs} ms of transport time`);
	};
	const settle = async <T>(promise: Promise<T>, what: string, budgetMs = 600_000): Promise<T> => {
		let outcome: { value: T } | { error: unknown } | undefined;
		promise.then(
			(value) => void (outcome = { value }),
			(error: unknown) => void (outcome = { error }),
		);
		await runUntil(() => outcome !== undefined, what, budgetMs);
		if (outcome === undefined || "error" in outcome) throw outcome?.error;
		return outcome.value;
	};
	return { advance: (ms) => pump(() => false, ms), settle, runUntil };
}

export async function openHandRig(
	adapters: HandCaseAdapters,
	options: {
		readonly placement: HandPlacement;
		readonly killAt?: KillPoint;
		readonly fault?: (timers: ManualTimers) => CarrierFault;
		/** The planes the session serves to its calls' nested requests (S26b dialogs). */
		readonly planes?: Readonly<Record<string, PlaneHandler>>;
		/** Replaces the default body (`ran:<toolCallId>`), for cases whose calls ask the session something. */
		readonly body?: (handCall: HandCall) => Promise<AgentToolResult<unknown>>;
	},
): Promise<HandRig> {
	const timers = createManualTimers(1_000);
	const network = createInProcessNetwork({ schedule: (deliver) => void timers.setTimer(deliver, 0) });
	const sessionSide = adapters.transport.createSide(timers);
	const handSide = adapters.transport.createSide(timers);
	const installed = options.fault?.(timers);
	const outer = (side: TransportSide): CarrierSide => (installed === undefined ? side : installed.wrap(side));
	const endpoint = localEndpoint(adapters.platform, "hand-conformance", "/run/senpi-conformance");
	network.listen(endpoint, outer(handSide));
	const link = network.dial(endpoint, outer(sessionSide));
	link.connect();
	installed?.start(link);

	const { medium } = await claimedStore(adapters.store);
	const bodies: string[] = [];
	const faults: unknown[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	let gated = false;
	const killed = Promise.withResolvers<void>();
	const scopeRunner = (scopeId: string): HandScope => ({
		run: async (handCall) => {
			bodies.push(`${scopeId}:${handCall.toolCallId}`);
			if (gated) {
				const gate = gates.get(handCall.toolCallId) ?? Promise.withResolvers<void>();
				gates.set(handCall.toolCallId, gate);
				await gate.promise;
			}
			if (options.body !== undefined) return options.body(handCall);
			return { content: [{ type: "text", text: `ran:${handCall.toolCallId}` }], details: {} };
		},
		isSequential: () => false,
		dispose: async () => {},
	});
	const startHand = (store: DurableStore) => {
		const ledger = createExecutionLedger({ store, epoch: 1, admission: createAdmissionLine() });
		return createRemoteExecutor({
			authority: { kind: "self" },
			transport: handSide,
			openScope: async (scope) => scopeRunner(scope.id),
			ledger: createHandLedger({
				ledger,
				executor: "hand",
				issuer: "session",
				workspace: "workspace",
				now: timers.now,
				leaseMs: LEASE_MS,
			}),
			onFault: (error) => faults.push(error),
		});
	};
	let commit = -1;
	let dead = false;
	const killing = (point: StoreWritePoint): void => {
		if (dead) throw new Error("the hand was killed");
		if (point.op !== "commit") return;
		if (point.at === "before") commit += 1;
		const kill = options.killAt;
		if (kill !== undefined && kill.commit === commit && kill.at === point.at) {
			dead = true;
			killed.resolve();
			throw new Error(`hand killed ${point.at} commit ${commit}`);
		}
	};
	let current = await adapters.store.open(medium, { onWritePoint: killing });
	await startHand(current).ready;
	const host = createRemoteToolHost({
		transport: sessionSide,
		placement: options.placement,
		...(options.planes === undefined ? {} : { planes: options.planes }),
	});
	const { advance, settle, runUntil } = transportPump(timers);
	return {
		advance,
		bodies,
		faults,
		killed: killed.promise,
		execute: (scope, calls, mode = "parallel") =>
			host.execute({ scope: { id: scope, root: `/work/${scope}` }, calls, mode }, { emit: () => {} }),
		kill() {
			dead = true;
			killed.resolve();
		},
		async restart() {
			current = await adapters.store.open(medium);
			await settle(startHand(current).ready, "the restarted hand recovered");
		},
		gateBodies: () => {
			gated = true;
		},
		release(toolCallId) {
			const gate = gates.get(toolCallId) ?? Promise.withResolvers<void>();
			gates.set(toolCallId, gate);
			gate.resolve();
		},
		settle,
		runUntil,
		disconnect: () => link.drop(),
		reconnect: () => link.connect(),
		rows: async () =>
			createExecutionLedger({
				store: await adapters.store.open(medium),
				epoch: 1,
				admission: createAdmissionLine(),
			}).scan(),
	};
}
