import { access, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecureFileMonitorWorkerPool } from "../../src/core/extensions/builtin/terminal/secure-file-monitor-worker.ts";
import { sanitizeSecureWorkerEnvironment } from "../../src/core/extensions/builtin/terminal/secure-file-monitor-worker-boundary.ts";

const malformedReadyWorker = `
console.log(JSON.stringify({ type: "ready", device: "not-a-bigint", inode: "1" }));
setInterval(() => {}, 1000);
`;

const stubbornWorker = `
const { statSync } = require("node:fs");
const { createInterface } = require("node:readline");
const identity = statSync(".", { bigint: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), 1000).unref();
send({ type: "ready", device: String(identity.dev), inode: String(identity.ino) });
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "register") send({ type: "registered", requestId: request.requestId });
});
`;

const mismatchedResponseWorker = `
const { statSync } = require("node:fs");
const { createInterface } = require("node:readline");
const identity = statSync(".", { bigint: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready", device: String(identity.dev), inode: String(identity.ino) });
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "register") send({ type: "reconciled", requestId: request.requestId });
});
`;

const bogusEventWorker = `
const { statSync } = require("node:fs");
const { createInterface } = require("node:readline");
const identity = statSync(".", { bigint: true });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ type: "ready", device: String(identity.dev), inode: String(identity.ino) });
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type !== "register") return;
	send({ type: "registered", requestId: request.requestId });
	setImmediate(() => send({ type: "event", id: request.id, event: { type: "bogus" } }));
});
`;

function withDeadline<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
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

describe("secure file monitor worker failure bounds", () => {
	it("allowlists the worker environment instead of inheriting loader variables", () => {
		expect(
			sanitizeSecureWorkerEnvironment({
				DYLD_INSERT_LIBRARIES: "./watched-directory.dylib",
				LD_PRELOAD: "./watched-directory.so",
				NODE_OPTIONS: "--require ./preload.cjs",
				PATH: "/watched-directory",
				SECRET: "must-not-cross-the-boundary",
				SystemRoot: "C:\\Windows",
				windir: "C:\\Windows",
			}),
		).toEqual({
			SYSTEMROOT: "C:\\Windows",
			WINDIR: "C:\\Windows",
		});
	});

	it("rejects malformed ready identity values without wedging registration", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-malformed-ready-")));
		const identity = await stat(root, { bigint: true });
		const pool = new SecureFileMonitorWorkerPool({
			startupTimeoutMs: 1000,
			workerCommand: [process.execPath, "-e", malformedReadyWorker],
		});

		try {
			await expect(
				withDeadline(
					pool.register({
						directory: root,
						expectedDevice: identity.dev,
						expectedInode: identity.ino,
						targetName: "claim.json",
						event: "create",
						timeoutMs: 5000,
						onEvent: () => {},
					}),
					"malformed ready rejection",
					2000,
				),
			).rejects.toThrow(/BigInt|bigint/);
			expect(pool.workerCount).toBe(0);
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("escalates termination when a worker ignores graceful shutdown", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-stubborn-worker-")));
		const identity = await stat(root, { bigint: true });
		const pool = new SecureFileMonitorWorkerPool({
			requestTimeoutMs: 50,
			workerCommand: [process.execPath, "-e", stubbornWorker],
		});

		try {
			await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "claim.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: () => {},
			});
			await expect(withDeadline(pool.dispose(), "stubborn worker termination", 500)).resolves.toBeUndefined();
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not inherit Node startup options from the watched directory", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-node-options-")));
		const identity = await stat(root, { bigint: true });
		const marker = join(root, "preload-ran");
		const previousNodeOptions = process.env.NODE_OPTIONS;
		const pool = new SecureFileMonitorWorkerPool();

		await writeFile(join(root, "preload.cjs"), `require("node:fs").writeFileSync("preload-ran", "1");`);
		process.env.NODE_OPTIONS = "--require ./preload.cjs";
		try {
			await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "claim.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: () => {},
			});
			await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = previousNodeOptions;
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects a response type that does not match the pending request", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-mismatched-response-")));
		const identity = await stat(root, { bigint: true });
		const pool = new SecureFileMonitorWorkerPool({
			workerCommand: [process.execPath, "-e", mismatchedResponseWorker],
		});

		try {
			await expect(
				pool.register({
					directory: root,
					expectedDevice: identity.dev,
					expectedInode: identity.ino,
					targetName: "claim.json",
					event: "create",
					timeoutMs: 5000,
					onEvent: () => {},
				}),
			).rejects.toThrow("unexpected response");
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails a worker that emits an unknown event shape", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-bogus-event-")));
		const identity = await stat(root, { bigint: true });
		const event = Promise.withResolvers<{ type: string; message?: string }>();
		const pool = new SecureFileMonitorWorkerPool({
			workerCommand: [process.execPath, "-e", bogusEventWorker],
		});

		try {
			await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "claim.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: (value) => event.resolve(value),
			});
			await expect(withDeadline(event.promise, "protocol violation event", 2000)).resolves.toMatchObject({
				type: "error",
			});
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
});
