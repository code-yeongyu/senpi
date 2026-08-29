import { access, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import {
	type SecureFileMonitorWorkerEvent,
	SecureFileMonitorWorkerPool,
} from "../../src/core/extensions/builtin/terminal/secure-file-monitor-worker.ts";
import { resolveDefaultWorkerCommand } from "../../src/core/extensions/builtin/terminal/secure-file-monitor-worker-command.ts";
import { createMonitorTool, type MonitorInput } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

const delayedSecondRegisterWorker = `
const { statSync } = require("node:fs");
const { createInterface } = require("node:readline");
const identity = statSync(".", { bigint: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let registerCount = 0;
let delayedRegister;
send({ type: "ready", device: String(identity.dev), inode: String(identity.ino) });
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "register") {
		registerCount += 1;
		if (registerCount === 1) send({ type: "registered", requestId: request.requestId });
		else {
			delayedRegister = request;
			send({ type: "event", id: request.id, event: { type: "error", message: "second received" } });
		}
	} else if (request.type === "cancel") {
		send({ type: "cancelled", requestId: request.requestId });
		if (delayedRegister) setImmediate(() => send({ type: "registered", requestId: delayedRegister.requestId }));
	} else if (request.type === "reconcile") {
		send({ type: "reconciled", requestId: request.requestId });
	} else if (request.type === "shutdown") {
		process.exit(0);
	}
});
`;

const timeoutWorker = `
const { statSync } = require("node:fs");
const { createInterface } = require("node:readline");
const identity = statSync(".", { bigint: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let registerCount = 0;
send({ type: "ready", device: String(identity.dev), inode: String(identity.ino) });
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "register") {
		registerCount += 1;
		if (registerCount === 1) send({ type: "registered", requestId: request.requestId });
	} else if (request.type === "cancel") {
		send({ type: "cancelled", requestId: request.requestId });
	} else if (request.type === "shutdown") {
		process.exit(0);
	}
});
`;

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 3000);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

describe("secure file monitor worker concurrency", () => {
	it("routes compiled Bun executables through the hidden worker flag", () => {
		const compiled = resolveDefaultWorkerCommand({
			execPath: process.platform === "win32" ? "C:\\senpi\\pi.exe" : "/opt/senpi/pi",
			versions: { bun: "1.3.14" },
		});
		const source = resolveDefaultWorkerCommand({
			execPath: process.platform === "win32" ? "C:\\bun\\bun.exe" : "/opt/bun/bin/bun",
			versions: { bun: "1.3.14" },
		});

		expect(compiled).toEqual([
			process.platform === "win32" ? "C:\\senpi\\pi.exe" : "/opt/senpi/pi",
			"--internal-file-monitor-worker",
		]);
		expect(source.slice(0, 3)).toEqual(["node", "--input-type=commonjs", "-e"]);
	});

	it("does not execute Bun preloads from the monitored directory", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-bunfig-")));
		const sentinel = join(root, "preload-ran");
		await writeFile(join(root, "bunfig.toml"), 'preload = ["./preload.mjs"]\n');
		await writeFile(
			join(root, "preload.mjs"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "ran");\n`,
		);
		const identity = await stat(root, { bigint: true });
		const workerCommand = resolveDefaultWorkerCommand({
			execPath: process.platform === "win32" ? "C:\\bun\\bun.exe" : "/opt/bun/bin/bun",
			versions: { bun: "1.3.14" },
		});
		const pool = new SecureFileMonitorWorkerPool({ workerCommand });

		try {
			const registration = await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "claim.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: () => {},
			});
			await registration.stop();
			await expect(access(sentinel)).rejects.toThrow();
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps a concurrent registration alive while releasing the previous lease", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-lease-race-")));
		const identity = await stat(root, { bigint: true });
		const pool = new SecureFileMonitorWorkerPool({
			workerCommand: [process.execPath, "-e", delayedSecondRegisterWorker],
		});

		try {
			const secondReceived = Promise.withResolvers<SecureFileMonitorWorkerEvent>();
			const first = await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "first.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: () => {},
			});
			const secondPending = pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "second.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: secondReceived.resolve,
			});
			await withDeadline(secondReceived.promise, "second registration receipt");
			const stopping = first.stop();
			const second = await secondPending;
			await stopping;

			expect(pool.workerCount).toBe(1);
			await expect(second.reconcile()).resolves.toBeUndefined();
			await second.stop();
			expect(pool.workerCount).toBe(0);
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fences pending registrations before teardown returns", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-teardown-race-")));
		const manager = new TerminalManager();
		const registry = new MonitorRegistry(() => {});
		const tool = createMonitorTool({
			manager,
			monitorRegistry: registry,
			cwd: root,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
		});

		try {
			const pending = tool.execute("secure-teardown-race", {
				description: "pending at teardown",
				path: join(root, "claim.json"),
				event: "create",
			} as MonitorInput);
			const teardown = registry.teardown();
			const result = await pending;
			await teardown;

			expect(result.isError).toBe(true);
			expect(registry.snapshot()).toEqual([]);
			expect(registry.fileCount).toBe(0);
			await expect(registry.teardown()).resolves.toBeUndefined();
		} finally {
			await registry.teardown();
			await manager.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retires a shared worker when any request times out", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-timeout-")));
		const identity = await stat(root, { bigint: true });
		const workerStopped = Promise.withResolvers<SecureFileMonitorWorkerEvent>();
		const pool = new SecureFileMonitorWorkerPool({
			requestTimeoutMs: 50,
			workerCommand: [process.execPath, "-e", timeoutWorker],
		});

		try {
			const first = await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "first.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: workerStopped.resolve,
			});
			await expect(
				pool.register({
					directory: root,
					expectedDevice: identity.dev,
					expectedInode: identity.ino,
					targetName: "second.json",
					event: "create",
					timeoutMs: 5000,
					onEvent: () => {},
				}),
			).rejects.toThrow("request timed out");
			await expect(withDeadline(workerStopped.promise, "worker timeout error")).resolves.toMatchObject({
				type: "error",
			});
			await expect(first.stop()).resolves.toBeUndefined();
			expect(pool.workerCount).toBe(0);
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("isolates an event callback failure from other leases", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-callback-")));
		const identity = await stat(root, { bigint: true });
		const reported = Promise.withResolvers<Error>();
		const secondEvent = Promise.withResolvers<SecureFileMonitorWorkerEvent>();
		const pool = new SecureFileMonitorWorkerPool({ onError: reported.resolve });

		try {
			const first = await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "first.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: () => {
					throw new Error("event sink failed");
				},
			});
			const second = await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "second.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: secondEvent.resolve,
			});

			await writeFile(join(root, "first.json"), "first");
			await first.reconcile();
			const callbackError = await withDeadline(reported.promise, "callback failure report");
			expect(callbackError).toEqual(expect.objectContaining({ message: "event sink failed" }));
			expect(pool.workerCount).toBe(1);

			await writeFile(join(root, "second.json"), "second");
			await second.reconcile();
			await expect(withDeadline(secondEvent.promise, "second worker event")).resolves.toEqual({
				type: "created",
			});
			await first.stop();
			await second.stop();
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
