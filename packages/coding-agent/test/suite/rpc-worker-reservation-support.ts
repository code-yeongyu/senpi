import { parseArgs } from "../../src/cli/args.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import type { SessionWorkerClient } from "../../src/modes/rpc/session-worker-client.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";

const nativeSetTimeout = setTimeout;
const nativeClearTimeout = clearTimeout;

export async function reservationPhase<T>(name: string, signal: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	process.stderr.write(`RESERVATION_AWAIT ${name}\n`);
	try {
		const result = await Promise.race([
			signal,
			new Promise<never>((_resolve, reject) => {
				timer = nativeSetTimeout(() => reject(new Error(`Reservation phase timed out: ${name}`)), 10_000);
			}),
		]);
		process.stderr.write(`RESERVATION_DONE ${name}\n`);
		return result;
	} finally {
		nativeClearTimeout(timer);
	}
}

/** Real workers and production routing; only the observation sink is in memory. */
export function reservationHost(cwd: string, agentDir: string) {
	const records: unknown[] = [];
	const writer = new SessionEventWriter(() => {});
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"]),
			cwd,
			agentDir,
			appMode: "rpc",
		},
		closeGraceMs: 100,
		now: Date.now,
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	const workers = new Set<SessionWorkerClient>();
	const exited = new Set<SessionWorkerClient>();
	const births: Array<{ handle: string; threadId: number }> = [];
	const peers = new Set<string>();
	let peak = 0;
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
			const result = writer.withConnection(id, () => router.handle(command));
			// Allocation is synchronous before prepare awaits. Worker.exited itself
			// subscribed to the native exit event in the real client constructor.
			for (const entry of registry.list()) {
				const worker = registry.peek(entry.sessionId)?.worker;
				if (!worker || workers.has(worker)) continue;
				workers.add(worker);
				births.push({ handle: entry.sessionId, threadId: worker.worker.threadId });
				void worker.exited.then(() => exited.add(worker));
			}
			peak = Math.max(peak, registry.size);
			return result;
		},
		disconnect(id: string) {
			writer.unregisterConnection(id);
			return router.releaseConnection(id);
		},
		async dispose() {
			for (const worker of workers) worker.quarantine();
			await reservationPhase("cleanup-native-exits", Promise.all([...workers].map((worker) => worker.exited)));
			await router.dispose();
			for (const peer of peers) writer.unregisterConnection(peer);
		},
	};
}
