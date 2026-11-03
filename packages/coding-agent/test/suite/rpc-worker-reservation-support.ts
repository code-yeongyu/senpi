import { parseArgs } from "../../src/cli/args.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import {
	WorkerSessionRegistry,
	type WorkerSessionRegistryOptions,
} from "../../src/modes/rpc/worker-session-registry.ts";

const nativeSetTimeout = setTimeout;
const nativeClearTimeout = clearTimeout;

/**
 * The longest one awaited step may take on a correct host, however loaded. A step is at most one
 * real worker open, exit or command; the product itself fails an open that passes `openMs`, and
 * `controlMs` covers that failure reaching the caller. A fixed clock tighter than this (the former
 * 10 s) failed correct runs whenever host load slowed an isolate (senpi#4688).
 */
export const RESERVATION_STEP_CEILING_MS = SESSION_WORKER_LIMITS.openMs + SESSION_WORKER_LIMITS.controlMs;

/**
 * Awaits one named worker lifecycle event. It fails by name once the step outlives
 * `RESERVATION_STEP_CEILING_MS`, on a timer captured before any test fakes the clock, so a hang
 * fails within the product's own bound even while a case drives fake timers.
 */
export async function reservationStep<T>(name: string, signal: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	process.stderr.write(`RESERVATION_AWAIT ${name}\n`);
	try {
		const result = await Promise.race([
			signal,
			new Promise<never>((_resolve, reject) => {
				timer = nativeSetTimeout(
					() =>
						reject(new Error(`Reservation step not settled within ${RESERVATION_STEP_CEILING_MS} ms: ${name}`)),
					RESERVATION_STEP_CEILING_MS,
				);
			}),
		]);
		process.stderr.write(`RESERVATION_DONE ${name}\n`);
		return result;
	} finally {
		nativeClearTimeout(timer);
	}
}

/** Real workers and production routing; only the observation sink is in memory. */
export function reservationHost(
	cwd: string,
	agentDir: string,
	extension?: string,
	options: Pick<WorkerSessionRegistryOptions, "pathReservations"> = {},
) {
	const records: unknown[] = [];
	const writer = new SessionEventWriter(() => {});
	const workers = new Set<SessionWorkerClient>();
	const exited = new Set<SessionWorkerClient>();
	const births: Array<{ threadId: number }> = [];
	let peak = 0;
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs([
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				...(extension ? ["--extension", extension] : []),
			]),
			cwd,
			agentDir,
			appMode: "rpc",
		},
		closeGraceMs: 100,
		now: Date.now,
		...options,
		createWorker: (callbacks) => {
			const worker = new SessionWorkerClient(callbacks);
			workers.add(worker);
			births.push({ threadId: worker.worker.threadId });
			void worker.exited.then(() => exited.add(worker));
			peak = Math.max(peak, registry.size + 1);
			return worker;
		},
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	const peers = new Set<string>();
	return {
		registry,
		router,
		writer,
		records,
		workers,
		exited,
		births,
		get peak() {
			return peak;
		},
		connect(id: string) {
			peers.add(id);
			writer.registerConnection(id, {
				writeRaw: (line) => records.push(JSON.parse(line)),
				waitForBackpressure: () => Promise.resolve(),
			});
		},
		send(id: string, command: RpcCommand) {
			return writer.withConnection(id, () => router.handle(command));
		},
		disconnect(id: string) {
			writer.unregisterConnection(id);
			return router.releaseConnection(id);
		},
		async dispose() {
			for (const worker of workers) worker.quarantine();
			await reservationStep("cleanup-native-exits", Promise.all([...workers].map((worker) => worker.exited)));
			await router.dispose();
			for (const peer of peers) writer.unregisterConnection(peer);
		},
	};
}
