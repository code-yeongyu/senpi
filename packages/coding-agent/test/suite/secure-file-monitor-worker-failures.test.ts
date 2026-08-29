import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecureFileMonitorWorkerPool } from "../../src/core/extensions/builtin/terminal/secure-file-monitor-worker.ts";

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
});
