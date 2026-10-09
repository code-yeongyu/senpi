import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rename, rm, stat, unlink } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hermeticProviderEnv } from "../helpers/rpc-hermetic.ts";

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
const replacements: Server[] = [];
const deadlineMs = 45_000;
const packageRoot = resolve(import.meta.dirname, "../..");
const testTimeoutMs = 60_000;

afterEach(async () => {
	await Promise.all([...children].map((child) => stop(child, "SIGKILL")));
	await Promise.all(
		replacements.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, testTimeoutMs);

// Filesystem socket takeover is POSIX-only; Windows uses named pipes, not path entries.
describe.skipIf(process.platform === "win32")("RPC socket shutdown ownership", () => {
	for (const supervised of [false, true]) {
		describe(supervised ? "lifecycle supervisor" : "direct multi-session host", () => {
			it(
				"leaves a replacement socket present and connectable after SIGTERM",
				async () => {
					const host = await startHost(supervised);
					const replacementIdentity = await takeOver(host.socketPath);

					expect(await stop(host.child, "SIGTERM")).toEqual([143, null]);

					await expect(stat(host.socketPath)).resolves.toMatchObject(replacementIdentity);
					expect(await readReplacement(host.socketPath)).toBe("replacement-host");
				},
				testTimeoutMs,
			);

			it(
				"removes its own socket when no takeover occurred",
				async () => {
					const host = await startHost(supervised);
					expect((await stat(host.socketPath)).isSocket()).toBe(true);

					expect(await stop(host.child, "SIGTERM")).toEqual([143, null]);

					await expectSocketRemoved(host.socketPath);
				},
				testTimeoutMs,
			);

			it(
				"tolerates an already absent socket during shutdown",
				async () => {
					const host = await startHost(supervised);
					await unlink(host.socketPath);

					expect(await stop(host.child, "SIGTERM")).toEqual([143, null]);

					await expect(stat(host.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
				},
				testTimeoutMs,
			);
		});
	}

	it(
		"leaves a replacement socket connectable after supervisor SIGKILL and watchdog cleanup",
		async () => {
			const host = await startHost(true);
			const replacementIdentity = await takeOver(host.socketPath);

			// The host inherits the supervisor's stderr pipe. close waits for both
			// processes to release it, so the watchdog cleanup has finished too.
			expect(await stop(host.child, "SIGKILL")).toEqual([null, "SIGKILL"]);

			await expect(stat(host.socketPath)).resolves.toMatchObject(replacementIdentity);
			expect(await readReplacement(host.socketPath)).toBe("replacement-host");
		},
		testTimeoutMs,
	);

	it(
		"removes the supervisor's own public socket on watchdog cleanup without a takeover",
		async () => {
			const host = await startHost(true);
			expect((await stat(host.socketPath)).isSocket()).toBe(true);

			expect(await stop(host.child, "SIGKILL")).toEqual([null, "SIGKILL"]);

			await expectSocketRemoved(host.socketPath);
		},
		testTimeoutMs,
	);
});

async function startHost(supervised: boolean): Promise<{
	child: ChildProcessWithoutNullStreams;
	socketPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "rpc-owner-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const socketPath = join(root, "rpc.sock");
	const args = supervised
		? [
				"--import",
				"tsx",
				join(packageRoot, "src/modes/rpc/host-lifecycle.ts"),
				"--socket",
				socketPath,
				"--agent-dir",
				agentDir,
			]
		: [join(packageRoot, "src/cli.ts"), "--mode", "rpc", "--listen", `unix://${socketPath}`];
	const child = spawn(process.execPath, args, {
		// The package root keeps `--import tsx` resolvable from node_modules for the
		// supervisor route (the existing lifecycle suite spawns the same way); the
		// hermetic scratch directories above carry every path the host touches.
		cwd: packageRoot,
		env: {
			...process.env,
			...hermeticProviderEnv(),
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			SENPI_RUNTIME: "node",
			SENPI_CODING_AGENT_DIR: agentDir,
			SENPI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
			SENPI_RPC_HOST_COLD_START: "persistent",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	child.once("close", () => children.delete(child));
	const readiness = supervised ? `ready on unix://${socketPath}` : `listening on unix://${socketPath}`;
	await new Promise<void>((resolve, reject) => {
		let stderr = "";
		const timer = setTimeout(() => fail(new Error(`Host readiness timed out: ${stderr}`)), deadlineMs);
		const cleanup = () => {
			clearTimeout(timer);
			child.stderr.off("data", onData);
			child.off("error", fail);
			child.off("close", onClose);
		};
		const fail = (cause: Error) => {
			cleanup();
			reject(cause);
		};
		const onClose = () => fail(new Error(`Host exited before readiness: ${stderr}`));
		const onData = (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (!stderr.includes(readiness)) return;
			cleanup();
			resolve();
		};
		child.stderr.on("data", onData);
		child.once("error", fail);
		child.once("close", onClose);
	});
	return { child, socketPath };
}

/**
 * The public socket is unlinked by whichever process owns the teardown (the supervised host's
 * watchdog shutdown, or the host's own SIGTERM path), and that unlink is not sequenced before the
 * supervisor's `close` reaches this process. Wait for the removal itself, bounded, instead of
 * asserting one stat snapshot taken at `close`.
 */
async function expectSocketRemoved(socketPath: string): Promise<void> {
	await vi.waitFor(() => expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" }), {
		timeout: deadlineMs,
		interval: 25,
	});
}

async function stop(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<unknown[]> {
	const closed = once(child, "close", { signal: AbortSignal.timeout(deadlineMs) });
	child.kill(signal);
	return closed;
}

async function takeOver(socketPath: string): Promise<{ dev: number; ino: number }> {
	const takeoverPath = `${socketPath}.takeover`;
	const server = createServer((socket) => socket.end("replacement-host"));
	replacements.push(server);
	const listening = once(server, "listening", { signal: AbortSignal.timeout(deadlineMs) });
	server.listen(takeoverPath);
	await listening;
	const { dev, ino } = await stat(takeoverPath);
	const oldIdentity = await stat(socketPath);
	expect([dev, ino]).not.toEqual([oldIdentity.dev, oldIdentity.ino]);
	await rename(takeoverPath, socketPath);
	return { dev, ino };
}

async function readReplacement(socketPath: string): Promise<string> {
	const socket = new Socket();
	let response = "";
	socket.on("data", (chunk: Buffer) => {
		response += chunk.toString("utf8");
	});
	const ended = once(socket, "end", { signal: AbortSignal.timeout(deadlineMs) });
	socket.connect(socketPath);
	try {
		await ended;
		return response;
	} finally {
		socket.destroy();
	}
}
