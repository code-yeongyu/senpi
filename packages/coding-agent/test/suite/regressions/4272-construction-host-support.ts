import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, vi } from "vitest";
import type { HandoverParkedEntry } from "../../../src/modes/rpc/host-handover-parked.ts";
import { LegacyReplayStore } from "../../../src/modes/rpc/legacy-replay-store.ts";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import type { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import type { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { statusHost } from "../rpc-session-status-support.ts";
import { within, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

// Part of #4272 (S07b, RULING-52): the in-process and worker hosts behind the production router, and the replay-store
// instrumentation the construction-path tests assert with.

export const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";

export type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

/** One `LegacyReplayStore` method call: the method and the session it named (its first argument). */
export type StoreCall = { readonly method: string; readonly sessionId: unknown };

/** Spies every method of the replay store's prototype, so a read added later is covered without editing the test. */
export function storeCalls(): StoreCall[] {
	const calls: StoreCall[] = [];
	for (const method of Object.getOwnPropertyNames(LegacyReplayStore.prototype)) {
		const descriptor = Object.getOwnPropertyDescriptor(LegacyReplayStore.prototype, method);
		if (method === "constructor" || typeof descriptor?.value !== "function") continue;
		const original = descriptor.value as (...args: unknown[]) => unknown;
		vi.spyOn(
			LegacyReplayStore.prototype as unknown as Record<string, (...args: unknown[]) => unknown>,
			method,
		).mockImplementation(function (this: LegacyReplayStore, ...args: unknown[]) {
			calls.push({ method, sessionId: args[0] });
			return original.apply(this, args);
		});
	}
	return calls;
}

export function laneOwned(writer: SessionEventWriter, sessionId: string): boolean {
	return (Reflect.get(writer, "fanout") as SessionEventFanout).acceptance.has(sessionId);
}

export interface Peer {
	readonly lines: WireRecord[];
	hold(): void;
	release(): void;
}

export interface Opened {
	readonly sessionId: string;
	readonly durableSessionId: string;
	readonly sessionPath: string;
	readonly attached: boolean;
}

/** A session a path drove one turn on, with whether the writer routed it through a lane during that turn. */
export interface Driven {
	readonly sessionId: string;
	readonly laneOwned: boolean;
}

/** One production host flavour behind the router: what a construction path needs, and every record it enqueued. */
export interface ConstructionHost {
	readonly kind: "in-process" | "worker";
	readonly writer: SessionEventWriter;
	readonly enqueued: ReadonlyArray<{ readonly sessionId: string; readonly record: WireRecord }>;
	readonly driven: Driven[];
	connect(name: string, options?: { maxQueueBytes?: number; capabilities?: readonly string[] }): Peer;
	/** A command as `via` sent it (no connection: the stdio host's shape); resolves with its response. */
	request(via: string | undefined, command: { readonly type: string } & WireRecord): Promise<WireRecord>;
	open(via: string | undefined, fields?: WireRecord): Promise<Opened>;
	/**
	 * One full turn on `sessionId`, prompted by `via`; records whether the session was lane-owned during it. `flush`
	 * false skips draining the transports, for a test that holds one.
	 */
	turn(sessionId: string, via: string | undefined, flush?: boolean): Promise<void>;
	reopenParked(entry: HandoverParkedEntry): Promise<RpcResponse | undefined>;
	dispose(): Promise<void>;
}

function hostWiring(
	kind: ConstructionHost["kind"],
	writer: SessionEventWriter,
	handle: (command: RpcCommand) => Promise<RpcResponse | undefined>,
	openDefaults: () => WireRecord,
	beforeTurn: () => void,
): Omit<ConstructionHost, "reopenParked" | "dispose"> {
	const enqueued: Array<{ sessionId: string; record: WireRecord }> = [];
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of [...listeners]) listener();
	};
	const enqueue = writer.enqueue.bind(writer);
	vi.spyOn(writer, "enqueue").mockImplementation((sessionId, record) => {
		enqueued.push({ sessionId, record: record as WireRecord });
		notify();
		return enqueue(sessionId, record);
	});
	const inboxes = new Map<string, WireRecord[]>();
	const seen = (predicate: (record: WireRecord) => boolean, from: number) =>
		enqueued.slice(from).find(({ record }) => predicate(record))?.record ??
		[...inboxes.values()].flat().find(predicate);
	const wait = (name: string, predicate: (record: WireRecord) => boolean, from = 0): Promise<WireRecord> => {
		const found = Promise.withResolvers<WireRecord>();
		const check = () => {
			const hit = seen(predicate, from);
			if (!hit) return;
			listeners.delete(check);
			found.resolve(hit);
		};
		listeners.add(check);
		check();
		return within(name, found.promise);
	};
	let serial = 0;
	const driven: Driven[] = [];
	const request: ConstructionHost["request"] = async (via, command) => {
		const id = `${via ?? "stdio"}-${++serial}`;
		const routed = { ...command, id } as RpcCommand;
		const direct = await (via === undefined ? handle(routed) : writer.withConnection(via, () => handle(routed)));
		if (direct) return direct as WireRecord;
		return wait(`response ${command.type}`, (record) => record.type === "response" && record.id === id);
	};
	const success = (record: WireRecord): Record<string, unknown> => {
		expect(record.success, JSON.stringify(record)).toBe(true);
		return (record.data as Record<string, unknown> | undefined) ?? {};
	};
	return {
		kind,
		writer,
		enqueued,
		driven,
		connect(name, options = {}) {
			const lines: WireRecord[] = [];
			inboxes.set(name, lines);
			let held: PromiseWithResolvers<void> | undefined;
			writer.registerConnection(
				name,
				{
					writeRaw: (chunk) => {
						for (const text of chunk.split("\n")) if (text !== "") lines.push(JSON.parse(text) as WireRecord);
						notify();
					},
					waitForBackpressure: () => held?.promise ?? Promise.resolve(),
				},
				options.maxQueueBytes === undefined ? {} : { maxQueueBytes: options.maxQueueBytes },
			);
			if (options.capabilities) writer.setConnectionCapabilities(name, options.capabilities);
			return {
				lines,
				hold: () => {
					held = Promise.withResolvers<void>();
				},
				release: () => {
					held?.resolve();
					held = undefined;
				},
			};
		},
		request,
		async open(via, fields = {}) {
			const data = success(await request(via, { type: "open_session", ...openDefaults(), ...fields }));
			const state = data.state as { sessionId: string; sessionFile: string };
			return {
				sessionId: String(data.sessionId),
				durableSessionId: state.sessionId,
				sessionPath: state.sessionFile,
				attached: data.attached === true,
			};
		},
		async turn(sessionId, via, flush = true) {
			const owned = laneOwned(writer, sessionId);
			beforeTurn();
			const from = enqueued.length;
			success(await request(via, { type: "prompt", sessionId, message: "stream an answer" }));
			await wait(
				`${sessionId} agent_idle`,
				(record) => record.sessionId === sessionId && record.type === "agent_idle",
				from,
			);
			if (flush) await writer.flush();
			driven.push({ sessionId, laneOwned: owned });
		},
	};
}

/** The in-process registry a `--listen` host selects (`createHostCore`), real runtimes on a faux provider. */
export async function inProcessConstructionHost(): Promise<ConstructionHost> {
	const host = await statusHost();
	const answer = "an answer streamed in several deltas so a small transport budget overflows behind it";
	const wiring = hostWiring(
		"in-process",
		host.writer,
		(command) => host.core.router.handle(command),
		() => ({ cwd: host.cwd, retain_on_disconnect: true }),
		() => host.faux.setResponses([fauxAssistantMessage(answer, { timestamp: 1 })]),
	);
	return {
		...wiring,
		reopenParked: (entry) => host.core.router.reopenParked({ ...entry, cwd: host.cwd }),
		dispose: () => host[Symbol.asyncDispose](),
	};
}

/** Real session workers behind the production router (`WorkerSessionRegistry`, the daemon's isolate registry). */
export async function workerConstructionHost(): Promise<ConstructionHost> {
	const host = await workerAcceptanceHost();
	let paths = 0;
	const wiring = hostWiring(
		"worker",
		host.writer,
		(command) => host.router.handle(command),
		() => ({
			cwd: host.dir,
			sessionPath: join(host.dir, `path-${++paths}.jsonl`),
			provider: "faux",
			modelId: "faux-1",
		}),
		() => {},
	);
	return {
		...wiring,
		reopenParked: (entry) =>
			host.router.reopenParked({ ...entry, cwd: host.dir, model: { provider: "faux", modelId: "faux-1" } }),
		dispose: () => host.dispose(),
	};
}

export const HOSTS = [
	["in-process", inProcessConstructionHost],
	["worker", workerConstructionHost],
] as const;
