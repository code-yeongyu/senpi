import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../../src/cli/args.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import type { FrozenAcceptedRoot } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { SessionWorkerClient } from "../../../src/modes/rpc/session-worker-client.ts";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../../src/modes/rpc/worker-session-registry.ts";

const fauxPath = fileURLToPath(new URL("../../../../ai/src/providers/faux.ts", import.meta.url));
/** The isolate's own build of the faux provider, so its provider capture is the one the isolate's session reads. */
export const builtFauxPath = fileURLToPath(new URL("../../../../ai/dist/providers/faux.js", import.meta.url));
const extensionSource = (faux: string, prelude: string) => `
import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(faux)};
${prelude}
export default function (pi) {
	const faux = fauxProvider({ tokenSize: { min: 4, max: 4 } });
	const answer = () => fauxAssistantMessage("an answer streamed in a few deltas", { timestamp: 1 });
	faux.setResponses([answer(), answer(), answer()]);
	pi.registerProvider(faux.provider);
}`;

export type WireRecord = Record<string, unknown>;
export type OutputFrame = Extract<SessionWorkerToHost, { type: "output" }>;

/** An output frame as the host received it, with the lane's root read as the frame arrived (before its own apply). */
export interface ObservedFrame {
	readonly frame: OutputFrame;
	readonly atArrival: FrozenAcceptedRoot | undefined;
	/** The credit the previous frame of this worker held when this one arrived (0 = none yet). */
	readonly previousCredit: number | undefined;
}

export function within<T>(name: string, promise: Promise<T>, ms = 30_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`deadline: ${name}`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export async function creditOf(signal: SharedArrayBuffer): Promise<number> {
	const state = new Int32Array(signal);
	const waited = Atomics.waitAsync(state, 0, 0, 10_000);
	if (waited.async) await waited.value;
	return Atomics.load(state, 0);
}

/**
 * Real session workers, the production router and writer, and the registry's own reconcile callback, which a
 * test may hold for one frame through `holdReconcile`. Only the connection sink is in memory.
 */
export async function workerAcceptanceHost(fauxModule = fauxPath, isolatePrelude = "") {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-worker-"));
	const extensionPath = join(dir, "faux-extension.ts");
	await writeFile(extensionPath, extensionSource(fauxModule, isolatePrelude));
	const writer = new SessionEventWriter(() => {});
	const workers: SessionWorkerClient[] = [];
	const frames: ObservedFrame[] = [];
	/** Every typed failure a worker incarnation reported to the registry, in order. */
	const failures: string[] = [];
	let hold:
		| ((paths: readonly string[], arriving: SessionWorkerToHost | undefined) => Promise<void> | undefined)
		| undefined;
	let arriving: SessionWorkerToHost | undefined;
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs([
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--extension",
				extensionPath,
			]),
			cwd: dir,
			agentDir: join(dir, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 100,
		now: Date.now,
		createWorker: (callbacks) => {
			const worker = new SessionWorkerClient({
				...callbacks,
				failure: (error) => {
					failures.push(error);
					callbacks.failure(error);
				},
				reconcile: (paths) => {
					const held = hold?.(paths, arriving);
					return held ? held.then(() => callbacks.reconcile(paths)) : callbacks.reconcile(paths);
				},
			});
			// Registered after the client's own listener, so it runs right after the host received the frame.
			let previous: SharedArrayBuffer | undefined;
			// Seen before the client handles the message, so a hold can tell which frame a reconcile belongs to.
			worker.worker.prependListener("message", (message: SessionWorkerToHost) => {
				arriving = message;
			});
			worker.worker.on("message", (message: SessionWorkerToHost) => {
				if (message.type !== "output") return;
				const lane = worker.acceptance;
				const atArrival = lane?.freeze();
				if (lane && atArrival) lane.release(atArrival);
				const previousCredit = previous && Atomics.load(new Int32Array(previous), 0);
				previous = message.signal;
				frames.push({ frame: message, atArrival, previousCredit });
			});
			workers.push(worker);
			return worker;
		},
	});
	const router = new SessionCommandRouter(registry, writer, { cwd: dir });
	const records: WireRecord[] = [];
	const listeners = new Set<(record: WireRecord) => void>();
	writer.registerConnection("c", {
		writeRaw: (line) => {
			const record: WireRecord = JSON.parse(line);
			records.push(record);
			for (const listener of [...listeners]) listener(record);
		},
		waitForBackpressure: async () => {},
	});
	const next = (name: string, predicate: (record: WireRecord) => boolean): Promise<WireRecord> => {
		const found = Promise.withResolvers<WireRecord>();
		const listener = (record: WireRecord) => {
			if (!predicate(record)) return;
			listeners.delete(listener);
			found.resolve(record);
		};
		listeners.add(listener);
		return within(name, found.promise);
	};
	let serial = 0;
	const request = (command: { readonly type: string } & WireRecord): Promise<WireRecord> => {
		const id = `t-${++serial}`;
		const response = next(`response ${command.type}`, (record) => record.type === "response" && record.id === id);
		void writer.withConnection("c", () => router.handle({ ...command, id } as RpcCommand));
		return response;
	};
	return {
		dir,
		registry,
		router,
		writer,
		workers,
		frames,
		failures,
		records,
		next,
		request,
		/** Holds the registry's reconcile of the first frame `select` picks, until `release`. */
		holdReconcile(select: (arriving: SessionWorkerToHost | undefined) => boolean) {
			const reached = Promise.withResolvers<readonly string[]>();
			const release = Promise.withResolvers<void>();
			hold = (paths, message) => {
				if (!select(message)) return undefined;
				hold = undefined;
				reached.resolve(paths);
				return release.promise;
			};
			return { reached: within("reconcile held", reached.promise), release: () => release.resolve() };
		},
		async open(): Promise<{ sessionId: string; worker: SessionWorkerClient }> {
			const opened = await request({
				type: "open_session",
				cwd: dir,
				sessionPath: join(dir, `s-${serial}.jsonl`),
				provider: "faux",
				modelId: "faux-1",
			});
			if (opened.success !== true) throw new Error(`open failed: ${JSON.stringify(opened)}`);
			const sessionId = String((opened.data as { sessionId: string }).sessionId);
			const worker = registry.peek(sessionId)?.worker;
			if (!worker) throw new Error("open_session did not create a worker");
			return { sessionId, worker };
		},
		async dispose() {
			for (const worker of workers) worker.quarantine();
			await within("workers exit", Promise.all(workers.map((worker) => worker.exited)));
			await router.dispose();
			writer.unregisterConnection("c");
			await rm(dir, { recursive: true, force: true });
		},
	};
}
