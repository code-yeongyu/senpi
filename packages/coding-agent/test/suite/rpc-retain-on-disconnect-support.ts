import type { EventEmitter } from "node:events";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { buildRpcSessionState } from "../../src/modes/rpc/connection-handler.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import {
	type HostToSessionWorker,
	WORKER_CREDIT_CODES,
	type WorkerSnapshot,
} from "../../src/modes/rpc/session-worker-protocol.ts";
import { WorkerSessionRegistry } from "../../src/modes/rpc/worker-session-registry.ts";
import { createHarness } from "./harness.ts";

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };
type ListedSession = { sessionId: string; status: string; sessionPath?: string; attachments: number };
interface OpenFields {
	cwd?: string;
	sessionPath?: string;
	retain_on_disconnect?: boolean;
	kind?: "interactive" | "worker";
}

function acknowledged(signal: SharedArrayBuffer): Promise<void> {
	const state = new Int32Array(signal);
	const ready = Atomics.waitAsync(state, 0, 0, 10_000);
	return Promise.resolve(ready.value).then((result) => {
		if (result !== "ok" || Atomics.load(state, 0) !== WORKER_CREDIT_CODES.granted)
			throw new Error("Worker acknowledgement failed");
	});
}

/** Production host lifecycle and controlled worker transport; the caller installs the worker mock. */
export async function retainHost(options: { idleEvictionMs?: number; onRecord?: (record: WireRecord) => void } = {}) {
	const harness = await createHarness();
	const baseState = buildRpcSessionState(harness.session);
	const clock = { now: 0 };
	const paths = new Map<EventEmitter, string>();
	const posted: Array<{ worker: EventEmitter; message: HostToSessionWorker }> = [];
	let serial = 0;
	const snapshotFor = (path: string, activity?: Partial<WorkerSnapshot>): WorkerSnapshot => ({
		state: { ...baseState, sessionId: `durable-${path}`, sessionFile: path },
		sessionPath: path,
		liveSessionPaths: [path],
		busy: false,
		streaming: false,
		...activity,
	});
	vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
		this: EventEmitter,
		message: HostToSessionWorker,
	) {
		posted.push({ worker: this, message });
		switch (message.type) {
			case "prepare": {
				const path = message.profile.sessionPath ?? join(harness.tempDir, `session-${++serial}.jsonl`);
				paths.set(this, path);
				queueMicrotask(() =>
					this.emit("message", { type: "prepared", request: message.request, sessionPath: path }),
				);
				break;
			}
			case "commit": {
				const path = paths.get(this) ?? "";
				queueMicrotask(() =>
					this.emit("message", { type: "ready", request: message.request, snapshot: snapshotFor(path) }),
				);
				break;
			}
			case "bind":
			case "command":
			case "prompt_surface":
			case "browser_engine":
			case "permission_preset":
				queueMicrotask(() => this.emit("message", { type: "result", request: message.request }));
				break;
			case "close":
				queueMicrotask(() => this.emit("exit", 0));
				break;
			case "cancel_ui":
				break;
			default: {
				const exhaustive: never = message;
				throw new Error(`Unexpected message ${exhaustive}`);
			}
		}
	});
	const records: WireRecord[] = [];
	const collect = (line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		records.push(record);
		options.onRecord?.(record);
	};
	const writer = new SessionEventWriter(collect);
	const registered = new Set<string>();
	const connect = (connection: string): string => {
		if (registered.has(connection)) return connection;
		writer.registerConnection(connection, { writeRaw: collect, waitForBackpressure: async () => {} });
		registered.add(connection);
		return connection;
	};
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs(["--mode", "rpc"]),
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			appMode: "rpc",
		},
		closeGraceMs: 100,
		now: () => clock.now,
	});
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: harness.tempDir },
		undefined,
		{},
		{ now: () => clock.now, idleEvictionMs: options.idleEvictionMs },
	);
	let requests = 0;
	const settle = () => writer.flush();
	return {
		registry,
		router,
		writer,
		records,
		posted,
		clock,
		cwd: harness.tempDir,
		settle,
		async open(connection: string, fields: OpenFields): Promise<WireRecord | undefined> {
			const id = `open-${++requests}`;
			const failure = await writer.withConnection(connect(connection), () =>
				router.handle({ type: "open_session", id, ...fields }),
			);
			await settle();
			return (failure as WireRecord | undefined) ?? records.find((record) => record.id === id);
		},
		async close(connection: string, sessionId: string): Promise<void> {
			await writer.withConnection(connection, () =>
				router.handle({ type: "close_session", id: `close-${++requests}`, sessionId }),
			);
			await settle();
		},
		async drop(connection: string): Promise<void> {
			writer.unregisterConnection(connection);
			registered.delete(connection);
			await router.releaseConnection(connection);
			await settle();
		},
		async list(): Promise<ListedSession[]> {
			const response = await router.handle({
				type: "list_sessions",
				id: `list-${++requests}`,
				include_workers: true,
			});
			return (response as { data?: { sessions?: ListedSession[] } } | undefined)?.data?.sessions ?? [];
		},
		client(sessionId: string) {
			const client = registry.peek(sessionId)?.worker;
			if (!client) throw new Error(`Expected a worker client for ${sessionId}`);
			const path = client.snapshot?.sessionPath ?? "";
			return {
				activity(activity: Partial<WorkerSnapshot>, settled?: boolean) {
					const signal = new SharedArrayBuffer(8);
					const ready = acknowledged(signal);
					client.worker.emit("message", {
						type: "snapshot",
						snapshot: snapshotFor(path, activity),
						signal,
						...(settled ? { settled: true } : {}),
					});
					return ready;
				},
				output(record: object) {
					const signal = new SharedArrayBuffer(8);
					const ready = acknowledged(signal);
					client.worker.emit("message", {
						type: "output",
						record,
						signal,
						activity: { busy: false, streaming: false },
					});
					return ready;
				},
			};
		},
		async [Symbol.asyncDispose]() {
			await router.dispose();
			harness.cleanup();
		},
	};
}
