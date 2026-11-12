import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { hermeticProviderEnv } from "./rpc-hermetic.ts";
import { JsonlPeer, type RecordValue } from "./rpc-jsonl-peer.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

const roots: string[] = [];

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
	await Promise.all(children.splice(0).map(stopChild));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
export function scratch(label: string): {
	root: string;
	agentDir: string;
	sessionDir: string;
	cwd: string;
	socketPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), `senpi-rpc-socket-${label}-`));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	// The host refuses a key root writable by group or others, so the fixture owns its mode (senpi#4541).
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return {
		root,
		agentDir,
		sessionDir,
		cwd,
		socketPath: join(root, "rpc.sock"),
	};
}
export function spawnRpc(
	args: string[],
	qa: ReturnType<typeof scratch>,
	capabilities = "extension_events,custom_unsupported",
	env: Readonly<Record<string, string>> = {},
): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, [join(import.meta.dirname, "..", "..", "src", "cli.ts"), ...args], {
		cwd: qa.cwd,
		env: {
			...hostSpawnEnv(),
			...hermeticProviderEnv(),
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			SENPI_RUNTIME: "node",
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
			SENPI_RPC_CLIENT_CAPABILITIES: capabilities,
			...env,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}
/**
 * Resolves when the child's stderr contains `text`; rejects when the child exits first.
 * No wall-clock deadline of its own: host startup on a loaded machine can take longer than any
 * fixed readiness window (senpi#5340), and vitest's testTimeout is the outer bound.
 */
export async function waitForStderr(child: ChildProcessWithoutNullStreams, text: string): Promise<void> {
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		const onData = (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
			if (stderr.includes(text)) {
				cleanup();
				resolve();
			}
		};
		const onExit = () => {
			cleanup();
			reject(new Error(`RPC host exited before readiness: ${stderr}`));
		};
		const cleanup = () => {
			child.stderr.off("data", onData);
			child.off("exit", onExit);
		};
		child.stderr.on("data", onData);
		child.once("exit", onExit);
	});
}
export async function connectPeer(socketPath: string): Promise<{ socket: Socket; peer: JsonlPeer }> {
	const socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return { socket, peer: new JsonlPeer(socket, (line) => socket.write(line)) };
}
export function openedSessionId(response: RecordValue): string {
	const data = response.data as RecordValue | undefined;
	if (typeof data?.sessionId !== "string") throw new Error(`Missing opened session id: ${JSON.stringify(response)}`);
	return data.sessionId;
}
export function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("");
}
export async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 3_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
