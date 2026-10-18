/**
 * Harness for `test/rpc-protocol-identity.test.ts`: sandboxes, spawned hosts, JSONL waits and the
 * canonical `profile_id` a client recomputes. It lives beside the suite rather than inside it because
 * the identity cells need a REAL host process, and the process plumbing is bulkier than the cells.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { hermeticProviderEnv, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";

export type RecordValue = Record<string, unknown>;

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

/** Kills every host this harness spawned and removes every sandbox it made. */
export function cleanupSpawnedHosts(): void {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** Canonical form the wire contract pins: keys sorted, recomputable by any client. */
export function expectedProfileId(core: {
	extensions: readonly string[];
	multi_session: boolean;
	session_runtime: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				extensions: core.extensions,
				multi_session: core.multi_session,
				session_runtime: core.session_runtime,
			}),
		)
		.digest("hex");
}

export function scratch(label: string): { root: string; agentDir: string; cwd: string; socketPath: string } {
	const root = mkdtempSync(join(tmpdir(), `dh-pi-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeRpcModelsJson(agentDir, "http://127.0.0.1:1");
	writeFileSync(join(agentDir, "extensions", "probe.ts"), "export default function () {}\n");
	return { root, agentDir, cwd, socketPath: join(root, "rpc.sock") };
}

export function spawnHost(
	args: readonly string[],
	qa: { agentDir: string; cwd: string },
	env: Readonly<Record<string, string>> = {},
): ChildProcessWithoutNullStreams {
	const scrubbed = { ...process.env, ...hermeticProviderEnv() };
	for (const key of ["OMO_RPC_SOCKET_PATH", "SENPI_RPC_HOST_WATCH_FD", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET"]) {
		delete scrubbed[key];
	}
	const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), ...args], {
		cwd: qa.cwd,
		env: {
			...scrubbed,
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			SENPI_RUNTIME: "node",
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_CODING_AGENT_SESSION_DIR: join(qa.agentDir, "sessions"),
			...env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

/** Resolves on the first JSONL line matching `predicate`; rejects on exit or deadline. */
export function waitForJsonLine(
	stream: Readable,
	predicate: (value: RecordValue) => boolean,
	timeoutMs = 30_000,
): Promise<RecordValue> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const timer = setTimeout(() => {
			stream.off("data", onData);
			reject(new Error(`Timed out waiting for a JSONL line: ${buffer}`));
		}, timeoutMs);
		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString("utf8");
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim() !== "") {
					const value = JSON.parse(line) as RecordValue;
					if (predicate(value)) {
						clearTimeout(timer);
						stream.off("data", onData);
						resolve(value);
						return;
					}
				}
				index = buffer.indexOf("\n");
			}
		};
		stream.on("data", onData);
	});
}

export function waitForStderr(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
	let stderr = "";
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.stderr.off("data", onData);
			reject(new Error(`Timed out waiting for ${JSON.stringify(text)}: ${stderr}`));
		}, 30_000);
		const onData = (chunk: Buffer): void => {
			stderr += chunk.toString("utf8");
			if (!stderr.includes(text)) return;
			clearTimeout(timer);
			child.stderr.off("data", onData);
			resolve();
		};
		child.stderr.on("data", onData);
	});
}

/** One probe on its OWN connection: the second one must observe the same identity. */
export async function probeSocket(socketPath: string, id: string): Promise<RecordValue> {
	const socket = createConnection(socketPath);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		const reply = waitForJsonLine(socket, (value) => value.id === id);
		socket.write(`${JSON.stringify({ id, type: "get_protocol_info" })}\n`);
		return (await reply).data as RecordValue;
	} finally {
		socket.destroy();
	}
}
