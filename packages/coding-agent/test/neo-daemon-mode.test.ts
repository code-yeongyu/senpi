/**
 * Neo daemon supervisor tests (plan task 15 groups a, b, c, d + handshake/race).
 *
 * These drive the supervisor with an INJECTED stub worker so the socket,
 * handshake, registry, idle-shutdown, and per-connection isolation logic are
 * tested deterministically without spawning real child processes. The
 * end-to-end auth-isolation proof against a fake model server lives in
 * neo-daemon-auth-isolation.test.ts (group e).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	NeoDaemonAddressInUseError,
	type NeoDaemonClock,
	type NeoDaemonHandle,
	type NeoDaemonWorker,
	type NeoDaemonWorkerFactory,
	runNeoDaemon,
} from "../src/modes/rpc/neo-daemon-mode.ts";
import { readNeoDaemonRecord } from "../src/modes/rpc/neo-daemon-registry.ts";
import type { NeoRuntimeOptions } from "../src/modes/rpc/neo-runtime-options.ts";

interface StubWorkerRecord {
	runtimeOptions: NeoRuntimeOptions;
	linesIn: string[];
	disposed: boolean;
}

/** A stub worker that echoes each inbound line back tagged with its own model. */
function makeStubFactory(records: StubWorkerRecord[]): NeoDaemonWorkerFactory {
	return async ({ runtimeOptions, writeToClient }) => {
		const record: StubWorkerRecord = { runtimeOptions, linesIn: [], disposed: false };
		records.push(record);
		const worker: NeoDaemonWorker = {
			handleLine(line: string) {
				record.linesIn.push(line);
				// Echo back including THIS connection's model so cross-talk is observable.
				writeToClient(`${JSON.stringify({ echo: line, model: runtimeOptions.model })}\n`);
			},
			async dispose() {
				record.disposed = true;
			},
		};
		return worker;
	};
}

/** A controllable clock so idle-shutdown fires on demand. */
function makeManualClock(): { clock: NeoDaemonClock; fire: () => void; armed: () => boolean } {
	let pending: (() => void) | undefined;
	return {
		clock: {
			setTimeout(handler) {
				pending = handler;
				return handler;
			},
			clearTimeout() {
				pending = undefined;
			},
		},
		fire() {
			const handler = pending;
			pending = undefined;
			handler?.();
		},
		armed: () => pending !== undefined,
	};
}

/** Read newline-delimited JSON messages from a socket. */
function collectLines(socket: Socket, onMessage: (msg: Record<string, unknown>) => void): void {
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (line.trim()) onMessage(JSON.parse(line));
			nl = buffer.indexOf("\n");
		}
	});
}

interface ClientConn {
	socket: Socket;
	messages: Record<string, unknown>[];
	next: () => Promise<Record<string, unknown>>;
	send: (obj: unknown) => void;
	end: () => void;
}

function openClient(listenPath: string): Promise<ClientConn> {
	return new Promise((resolve, reject) => {
		const socket = connect(listenPath);
		const messages: Record<string, unknown>[] = [];
		const waiters: Array<(msg: Record<string, unknown>) => void> = [];
		collectLines(socket, (msg) => {
			const waiter = waiters.shift();
			if (waiter) waiter(msg);
			else messages.push(msg);
		});
		socket.on("connect", () =>
			resolve({
				socket,
				messages,
				next: () =>
					new Promise((res) => {
						const queued = messages.shift();
						if (queued) res(queued);
						else waiters.push(res);
					}),
				send: (obj) => socket.write(`${JSON.stringify(obj)}\n`),
				end: () => socket.end(),
			}),
		);
		socket.on("error", reject);
	});
}

const TOKEN = "test-token-abc";

describe("neo daemon supervisor", () => {
	let agentDir: string;
	let listenPath: string;
	let handle: NeoDaemonHandle | undefined;
	const cwd = "/tmp/neo-daemon-mode-test-cwd";

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "neo-daemon-mode-"));
		// Short unix socket path (macOS limits sun_path to ~104 chars).
		listenPath = join(mkdtempSync(join(tmpdir(), "nds-")), "d.sock");
	});

	afterEach(async () => {
		await handle?.shutdown();
		handle = undefined;
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("completes the handshake and registers as the last listen step", async () => {
		const records: StubWorkerRecord[] = [];
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			register: true,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory(records),
		});

		// The registry record exists only after listen succeeded.
		const record = readNeoDaemonRecord(agentDir, cwd);
		expect(record).toMatchObject({ version: 1, socket: listenPath, token: TOKEN, pid: process.pid });

		const client = await openClient(listenPath);
		client.send({ type: "hello", token: TOKEN, version: 1, runtimeOptions: { model: "m-a" } });
		const welcome = await client.next();
		expect(welcome).toMatchObject({ type: "welcome", version: 1 });
		client.end();
	});

	it("(a) runs two concurrent connections with DIFFERENT runtimeOptions, no cross-talk", async () => {
		const records: StubWorkerRecord[] = [];
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory(records),
		});

		const a = await openClient(listenPath);
		const b = await openClient(listenPath);
		a.send({ type: "hello", token: TOKEN, version: 1, runtimeOptions: { model: "model-A", session: "sess-A" } });
		b.send({ type: "hello", token: TOKEN, version: 1, runtimeOptions: { model: "model-B", session: "sess-B" } });
		await a.next(); // welcome
		await b.next(); // welcome

		// Each connection's echo carries only its OWN model — no bleed.
		a.send({ type: "prompt", message: "hi-a" });
		b.send({ type: "prompt", message: "hi-b" });
		const echoA = await a.next();
		const echoB = await b.next();
		expect(echoA.model).toBe("model-A");
		expect(echoB.model).toBe("model-B");

		expect(handle.connectionCount()).toBe(2);
		expect(records).toHaveLength(2);
		expect(records[0].runtimeOptions.session).toBe("sess-A");
		expect(records[1].runtimeOptions.session).toBe("sess-B");
		a.end();
		b.end();
	});

	it("(b) refuses a bad token", async () => {
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory([]),
		});
		const client = await openClient(listenPath);
		client.send({ type: "hello", token: "WRONG", version: 1 });
		const reply = await client.next();
		expect(reply).toMatchObject({ type: "refuse", code: "bad_token" });
	});

	it("(c) refuses a version mismatch", async () => {
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 0,
			token: TOKEN,
			version: 1,
			workerFactory: makeStubFactory([]),
		});
		const client = await openClient(listenPath);
		client.send({ type: "hello", token: TOKEN, version: 999 });
		const reply = await client.next();
		expect(reply).toMatchObject({ type: "refuse", code: "version_mismatch" });
	});

	it("refuses unsupported runtimeOptions with a reason", async () => {
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory([]),
			validateRuntimeOptions: (o) => (o.model === "banned" ? "model 'banned' is not allowed" : undefined),
		});
		const client = await openClient(listenPath);
		client.send({ type: "hello", token: TOKEN, version: 1, runtimeOptions: { model: "banned" } });
		const reply = await client.next();
		expect(reply).toMatchObject({ type: "refuse", code: "unsupported_options" });
		expect(String(reply.reason)).toContain("banned");
	});

	it("(d) idle shutdown fires after the no-connection period (injected clock)", async () => {
		const manual = makeManualClock();
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 1000,
			token: TOKEN,
			workerFactory: makeStubFactory([]),
			clock: manual.clock,
		});
		// Armed immediately with zero connections.
		expect(manual.armed()).toBe(true);
		const closedPromise = handle.closed;
		manual.fire();
		await closedPromise; // resolves when the daemon shut down
		// Registry cleaned up on shutdown.
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeUndefined();
	});

	it("cancels the idle timer while a connection is live and re-arms on drop", async () => {
		const manual = makeManualClock();
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 1000,
			token: TOKEN,
			workerFactory: makeStubFactory([]),
			clock: manual.clock,
		});
		const client = await openClient(listenPath);
		client.send({ type: "hello", token: TOKEN, version: 1 });
		await client.next(); // welcome
		expect(manual.armed()).toBe(false); // no idle timer while connected
		client.end();
		// After the drop the daemon re-arms the idle timer.
		await new Promise((r) => setTimeout(r, 50));
		expect(manual.armed()).toBe(true);
	});

	it("aborts and disposes a connection's worker on disconnect", async () => {
		const records: StubWorkerRecord[] = [];
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory(records),
		});
		const client = await openClient(listenPath);
		client.send({ type: "hello", token: TOKEN, version: 1, runtimeOptions: { model: "m" } });
		await client.next();
		expect(records).toHaveLength(1);
		client.end();
		await new Promise((r) => setTimeout(r, 50));
		expect(records[0].disposed).toBe(true);
		expect(handle.connectionCount()).toBe(0);
	});

	it("a second daemon on the same socket loses the bind race (EADDRINUSE)", async () => {
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory([]),
		});
		await expect(
			runNeoDaemon({
				listenPath,
				cwd,
				agentDir,
				register: false,
				idleShutdownMs: 0,
				token: "other",
				workerFactory: makeStubFactory([]),
			}),
		).rejects.toBeInstanceOf(NeoDaemonAddressInUseError);
	});

	it("binds over an orphaned socket file with NO registry record (deterministic-path crash recovery)", async () => {
		// With a deterministic socket path, a daemon that crashed without a clean
		// shutdown can leave the socket FILE on disk while its registry record was
		// removed (or never matched). cleanupStaleNeoDaemon keys off the record and
		// so would miss this leftover — a fresh bind() then hits EADDRINUSE forever.
		// The daemon's own pre-bind cleanup must unlink the dead socket file first.
		const orphanServer = createServer();
		await new Promise<void>((resolve, reject) => {
			orphanServer.once("error", reject);
			orphanServer.once("listening", () => resolve());
			orphanServer.listen(listenPath);
		});
		// Emulate a crash: drop the listener without unlinking so the file lingers,
		// and leave NO registry record for this cwd.
		await new Promise<void>((resolve) => orphanServer.close(() => resolve()));
		// The listener's close removes the file, so recreate the leftover to model a
		// hard crash (SIGKILL) where Node never got to clean up.
		writeFileSync(listenPath, "");
		expect(existsSync(listenPath)).toBe(true);
		expect(readNeoDaemonRecord(agentDir, cwd)).toBeUndefined();

		// A fresh daemon must recover: unlink the dead socket file, then bind.
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			register: true,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory([]),
		});
		const record = readNeoDaemonRecord(agentDir, cwd);
		expect(record).toMatchObject({ socket: listenPath, pid: process.pid });
		const client = await openClient(listenPath);
		client.send({ type: "hello", token: TOKEN, version: 1 });
		expect(await client.next()).toMatchObject({ type: "welcome", version: 1 });
		client.end();
	});

	it("does NOT unlink a socket a LIVE daemon is serving (loser still gets EADDRINUSE)", async () => {
		// The pre-bind cleanup must distinguish a dead socket file from one a live
		// daemon is actively serving: connecting to the live one succeeds, so the
		// loser must leave it alone and lose the bind race rather than yanking the
		// winner's socket out from under it.
		handle = await runNeoDaemon({
			listenPath,
			cwd,
			agentDir,
			register: true,
			idleShutdownMs: 0,
			token: TOKEN,
			workerFactory: makeStubFactory([]),
		});
		// A concurrent racer on the SAME path with the winner still live must lose.
		await expect(
			runNeoDaemon({
				listenPath,
				cwd,
				agentDir,
				register: false,
				idleShutdownMs: 0,
				token: "loser",
				workerFactory: makeStubFactory([]),
			}),
		).rejects.toBeInstanceOf(NeoDaemonAddressInUseError);
		// The winner is untouched: still serving, still the registry owner.
		const record = readNeoDaemonRecord(agentDir, cwd);
		expect(record).toMatchObject({ socket: listenPath, token: TOKEN, pid: process.pid });
		const client = await openClient(listenPath);
		client.send({ type: "hello", token: TOKEN, version: 1 });
		expect(await client.next()).toMatchObject({ type: "welcome", version: 1 });
		client.end();
	});
});
