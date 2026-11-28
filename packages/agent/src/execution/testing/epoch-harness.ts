import type { AgentToolCall } from "../../types.ts";
import { createAdmissionLine } from "../../durable/store-admission.ts";
import type { DurableStore, StoreValue, StoreWrite } from "../../durable/store.ts";
import { createManualTimers } from "../../durable/testing/manual-timers.ts";
import { claimedStore } from "../../durable/testing/store-cases.ts";
import { createInProcessNetwork } from "../../transport/in-process-carrier.ts";
import { localEndpoint } from "../../transport/local-endpoint.ts";
import type { TransportSide } from "../../transport/transport.ts";
import { createGrantVerifier } from "../grant-verify.ts";
import { createExecutionLedger } from "../ledger.ts";
import type { ExecutionEntry } from "../ledger-types.ts";
import { createHandEpochFence, EPOCH_FLOOR_PREFIX } from "../remote-epoch.ts";
import { createRemoteExecutor } from "../remote-executor.ts";
import { createHandLedger } from "../remote-hand-ledger.ts";
import { createRemoteToolHost, type HandPlacement } from "../remote-tool-host.ts";
import type { ToolHostResult } from "../tool-host.ts";
import { type HandCaseAdapters, type TransportPump, transportPump } from "./hand-harness.ts";

export type CommitMatch = (writes: readonly StoreWrite[]) => boolean;

export interface EpochBrainSpec {
	/** The brain principal: its link's authenticated peer and the name `ownerOf` answers. */
	readonly name: string;
	readonly epoch: number;
}

export interface EpochRig extends TransportPump {
	/** Every tool body start, as `<scope>:<toolCallId>`, across all hand processes. */
	readonly bodies: readonly string[];
	readonly faults: readonly unknown[];
	readonly killed: Promise<void>;
	/** `turn`: the issuing assistant message's durable identity (senpi#5867). */
	execute(brain: string, scope: string, calls: readonly AgentToolCall[], turn?: string): Promise<ToolHostResult>;
	/** Moves `scope` to `brain` in the hand's placement record (what `ownerOf` answers). */
	setOwner(scope: string, brain: string): void;
	/** Holds the next commit `match` picks until `release()`; `reached` settles when it arrives. */
	hold(match: CommitMatch): { readonly reached: Promise<void>; release(): void };
	/** A new hand process on the reopened store; every link's executor announces itself. */
	restart(): Promise<void>;
	rows(): Promise<ExecutionEntry[]>;
	/** The floor persisted for `scope` (read from a fresh store instance), or `undefined`. */
	floor(scope: string): Promise<StoreValue | undefined>;
}

const LEASE_MS = 3_600_000;
const HAND = "hand";

const isRecord = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const field = (write: StoreWrite, name: string): StoreValue | undefined => {
	const data = write.op === "delete" ? undefined : write.data;
	return isRecord(data) ? data[name] : undefined;
};

export const floorCommit =
	(scope: string, epoch: number): CommitMatch =>
	(writes) =>
		writes.some(
			(write) =>
				write.op === "put" && write.key === `${EPOCH_FLOOR_PREFIX}${scope}` && field(write, "epoch") === epoch,
		);

/** The ledger commit of `event` for a call `brain` sent (execution IDs are minted as `<brain>-<n>`). */
export const stepCommit =
	(brain: string, event: string): CommitMatch =>
	(writes) =>
		writes.some(
			(write) =>
				write.op === "append" &&
				field(write, "event") === event &&
				String(field(write, "commandId")).startsWith(`${brain}-`),
		);

interface Hold {
	readonly match: CommitMatch;
	readonly reached: PromiseWithResolvers<void>;
	readonly gate: PromiseWithResolvers<void>;
}

/** A hand process's store: holds and kills act on whole commits; after a kill every call fails, as in a dead process. */
function processStore(
	inner: DurableStore,
	holds: Hold[],
	kill: { readonly match: CommitMatch; readonly at: "before" | "durable"; readonly die: () => void } | undefined,
): DurableStore {
	let dead = false;
	const alive = (): void => {
		if (dead) throw new Error("the hand was killed");
	};
	const die = (at: string): never => {
		dead = true;
		kill?.die();
		throw new Error(`hand killed ${at} the matched commit`);
	};
	let killArmed = kill !== undefined;
	const live =
		<A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			alive();
			return read(...args);
		};
	return {
		readEpoch: live(() => inner.readEpoch()),
		readHead: live(() => inner.readHead()),
		claim: live((expected: number, next: number) => inner.claim(expected, next)),
		mintId: () => inner.mintId(),
		scanRecords: live((query?: Parameters<DurableStore["scanRecords"]>[0]) => inner.scanRecords(query)),
		getDocument: live((key: string) => inner.getDocument(key)),
		scanDocuments: live((prefix: string) => inner.scanDocuments(prefix)),
		exportSnapshot: live(() => inner.exportSnapshot()),
		importSnapshot: live((epoch: number, snapshot: Parameters<DurableStore["importSnapshot"]>[1]) =>
			inner.importSnapshot(epoch, snapshot),
		),
		async commit(epoch, writes, adopt) {
			alive();
			const index = holds.findIndex((hold) => hold.match(writes));
			const hold = index < 0 ? undefined : holds.splice(index, 1)[0];
			if (hold !== undefined) {
				hold.reached.resolve();
				await hold.gate.promise;
				alive();
			}
			const killing = killArmed && kill !== undefined && kill.match(writes);
			if (!killing) return inner.commit(epoch, writes, adopt);
			killArmed = false;
			if (kill.at === "before") return die("before");
			await inner.commit(epoch, writes, () => {});
			return die("once durable");
		},
	};
}

/**
 * One hand process reached by several brains, each over its own link with its own executor (a peer link per brain),
 * sharing the hand's store, ledger and epoch fence: what a session sees when it moves from one brain to another.
 */
export async function openEpochRig(
	adapters: HandCaseAdapters,
	options: {
		readonly brains: readonly EpochBrainSpec[];
		readonly placement?: HandPlacement;
		readonly kill?: { readonly match: CommitMatch; readonly at: "before" | "durable" };
	},
): Promise<EpochRig> {
	const timers = createManualTimers(1_000);
	const pump = transportPump(timers);
	const network = createInProcessNetwork({ schedule: (deliver) => void timers.setTimer(deliver, 0) });
	const verifier = createGrantVerifier({ self: HAND, workspaces: [{ root: "/work" }], canonicalize: (path) => path });
	verifier.install({
		rv: 1,
		expiresAt: Number.MAX_SAFE_INTEGER,
		grants: options.brains.map(({ name }) => ({
			holder: name,
			target: HAND,
			workspace: "omo",
			capability: "execute",
		})),
	});
	const handSides = new Map<string, TransportSide>();
	const hosts = new Map<string, ReturnType<typeof createRemoteToolHost>>();
	for (const { name, epoch } of options.brains) {
		const sessionSide = adapters.transport.createSide(timers);
		const handSide = adapters.transport.createSide(timers);
		const endpoint = localEndpoint(adapters.platform, `epoch-${name}`, "/run/senpi-conformance");
		network.listen(endpoint, handSide);
		network.dial(endpoint, sessionSide).connect();
		handSides.set(name, handSide);
		let minted = 0;
		const placement = options.placement ?? "cross-machine";
		hosts.set(
			name,
			createRemoteToolHost({ transport: sessionSide, placement, epoch, mintId: () => `${name}-${minted++}` }),
		);
	}

	const { medium } = await claimedStore(adapters.store);
	const owners = new Map<string, string>();
	const bodies: string[] = [];
	const faults: unknown[] = [];
	const holds: Hold[] = [];
	const killed = Promise.withResolvers<void>();
	const startHand = async (store: DurableStore): Promise<void> => {
		const admission = createAdmissionLine();
		const ledger = createExecutionLedger({ store, epoch: 1, admission });
		const hand = createHandLedger({
			ledger,
			executor: HAND,
			issuer: "session",
			workspace: "workspace",
			now: timers.now,
			leaseMs: LEASE_MS,
		});
		const fence = createHandEpochFence({
			ownerOf: (scope) => owners.get(scope),
			durable: { store, epoch: 1, admission },
		});
		const executors = options.brains.map(({ name }) => {
			const transport = handSides.get(name);
			if (transport === undefined) throw new Error(`no link for ${name}`);
			return createRemoteExecutor({
				authority: { kind: "peer", peer: name, verifier },
				transport,
				ledger: hand,
				fence,
				openScope: async (scope) => ({
					run: async (handCall) => {
						bodies.push(`${scope.id}:${handCall.toolCallId}`);
						return { content: [{ type: "text", text: `ran:${handCall.toolCallId}` }], details: {} };
					},
					isSequential: () => false,
					dispose: async () => {},
				}),
				onFault: (error) => faults.push(error),
			});
		});
		await pump.settle(Promise.all(executors.map(({ ready }) => ready)), "every link's executor is ready");
	};
	const kill = options.kill === undefined ? undefined : { ...options.kill, die: () => killed.resolve() };
	await startHand(processStore(await adapters.store.open(medium), holds, kill));
	const reader = async () => adapters.store.open(medium);

	return {
		...pump,
		bodies,
		faults,
		killed: killed.promise,
		execute(brain, scope, calls, turn) {
			const host = hosts.get(brain);
			if (host === undefined) throw new Error(`no brain ${brain}`);
			return host.execute(
				{
					scope: { id: scope, root: `/work/${scope}` },
					calls,
					mode: "parallel",
					...(turn === undefined ? {} : { turn }),
				},
				{ emit: () => {} },
			);
		},
		setOwner: (scope, brain) => void owners.set(scope, brain),
		hold(match) {
			const hold: Hold = { match, reached: Promise.withResolvers(), gate: Promise.withResolvers() };
			holds.push(hold);
			return { reached: hold.reached.promise, release: () => hold.gate.resolve() };
		},
		restart: async () => startHand(processStore(await reader(), holds, undefined)),
		rows: async () =>
			createExecutionLedger({ store: await reader(), epoch: 1, admission: createAdmissionLine() }).scan(),
		floor: async (scope) => (await reader()).getDocument(`${EPOCH_FLOOR_PREFIX}${scope}`),
	};
}
