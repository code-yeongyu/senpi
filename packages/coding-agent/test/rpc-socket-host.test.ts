import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
	await Promise.all(children.splice(0).map(stopChild));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type RecordValue = Record<string, unknown>;

class JsonlPeer {
	readonly messages: RecordValue[] = [];
	private readonly waiters = new Set<{
		predicate: (value: RecordValue) => boolean;
		resolve: (value: RecordValue) => void;
		reject: (cause: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly writeRaw: (line: string) => void;
	readonly detach: () => void;

	constructor(stream: Readable, writeRaw: (line: string) => void) {
		this.writeRaw = writeRaw;
		this.detach = attachJsonlLineReader(stream, (line) => this.record(JSON.parse(line) as RecordValue));
	}

	request(command: RecordValue, timeoutMs = 15_000): Promise<RecordValue> {
		const id = command.id;
		const response = this.waitFor((value) => value.type === "response" && value.id === id, timeoutMs);
		this.write(command);
		return response;
	}

	write(value: unknown): void {
		this.writeRaw(`${JSON.stringify(value)}\n`);
	}

	writeMalformed(line: string): void {
		this.writeRaw(`${line}\n`);
	}

	waitFor(predicate: (value: RecordValue) => boolean, timeoutMs = 15_000): Promise<RecordValue> {
		const existing = this.messages.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error("Timed out waiting for RPC record"));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	close(): void {
		this.detach();
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("RPC peer closed"));
		}
		this.waiters.clear();
	}

	private record(value: RecordValue): void {
		this.messages.push(value);
		for (const waiter of [...this.waiters]) {
			if (!waiter.predicate(value)) continue;
			clearTimeout(waiter.timer);
			this.waiters.delete(waiter);
			waiter.resolve(value);
		}
	}
}

function scratch(label: string): {
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
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, sessionDir, cwd, socketPath: join(root, "rpc.sock") };
}

function spawnRpc(args: string[], qa: ReturnType<typeof scratch>): ChildProcessWithoutNullStreams {
	const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli.ts"), ...args], {
		cwd: qa.cwd,
		env: {
			...process.env,
			...hermeticProviderEnv(),
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			SENPI_RUNTIME: "node",
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_CODING_AGENT_SESSION_DIR: qa.sessionDir,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	return child;
}

async function waitForStderr(child: ChildProcessWithoutNullStreams, text: string, timeoutMs = 15_000): Promise<void> {
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for stderr ${JSON.stringify(text)}: ${stderr}`));
		}, timeoutMs);
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
			clearTimeout(timer);
			child.stderr.off("data", onData);
			child.off("exit", onExit);
		};
		child.stderr.on("data", onData);
		child.once("exit", onExit);
	});
}

async function connectPeer(socketPath: string): Promise<{ socket: Socket; peer: JsonlPeer }> {
	const socket = createConnection(socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	return { socket, peer: new JsonlPeer(socket, (line) => socket.write(line)) };
}

function openedSessionId(response: RecordValue): string {
	const data = response.data as RecordValue | undefined;
	if (typeof data?.sessionId !== "string") throw new Error(`Missing opened session id: ${JSON.stringify(response)}`);
	return data.sessionId;
}

function messageText(message: unknown): string {
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

function normalizeResponse(value: RecordValue): RecordValue {
	const clone = structuredClone(value);
	delete clone.sessionId;
	if (clone.data && typeof clone.data === "object") {
		const data = clone.data as RecordValue;
		delete data.sessionId;
		delete data.sessionFile;
		if (Array.isArray(data.messages)) {
			data.messages = data.messages.map((message) => {
				if (typeof message !== "object" || message === null) return message;
				const normalized = { ...(message as RecordValue) };
				delete normalized.id;
				delete normalized.timestamp;
				return normalized;
			});
		}
	}
	return clone;
}

describe("RPC Unix-socket multi-connection host", () => {
	it("parses socket listeners as multi-session RPC", () => {
		expect(parseArgs(["--mode", "rpc", "--listen", "unix:///tmp/senpi.sock"])).toMatchObject({
			mode: "rpc",
			multiSession: true,
			listen: "unix:///tmp/senpi.sock",
		});
		expect(parseArgs(["--mode", "rpc", "--listen", "/tmp/senpi.sock"])).toMatchObject({
			multiSession: true,
			listen: "/tmp/senpi.sock",
		});
	});

	it("delivers foreign commands, broadcasts tagged events, survives malformed frames, and reconnects", async () => {
		const qa = scratch("semantics");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			a.peer.writeMalformed("{bad first frame");
			await expect(
				a.peer.waitFor((value) => value.command === "parse" && value.success === false),
			).resolves.toMatchObject({
				type: "response",
				command: "parse",
				success: false,
			});
			await expect(b.peer.request({ id: "probe-b", type: "get_protocol_info" })).resolves.toMatchObject({
				success: true,
			});

			const opened = await a.peer.request({ id: "open-a", type: "open_session", cwd: qa.cwd });
			const sessionId = openedSessionId(opened);

			const settledA = a.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			const settledB = b.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			await expect(
				b.peer.request({ id: "foreign-prompt", type: "prompt", sessionId, message: "unique-424242" }),
			).resolves.toMatchObject({ success: true, sessionId });
			await Promise.all([settledA, settledB]);

			const transcript = await b.peer.request({ id: "foreign-transcript", type: "get_messages", sessionId });
			const messages = ((transcript.data as { messages?: unknown[] }).messages ?? []).map(messageText);
			expect(messages).toContain("unique-424242");

			a.peer.writeMalformed("not-json-mid-stream");
			await a.peer.waitFor((value) => value.command === "parse" && value.success === false);
			await expect(b.peer.request({ id: "survives-mid", type: "get_state", sessionId })).resolves.toMatchObject({
				success: true,
				sessionId,
			});

			b.peer.close();
			b.socket.destroy();
			const reconnected = await connectPeer(qa.socketPath);
			try {
				await expect(
					reconnected.peer.request({ id: "reconnected", type: "get_state", sessionId }),
				).resolves.toMatchObject({ success: true, sessionId });
			} finally {
				reconnected.peer.close();
				reconnected.socket.destroy();
			}
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.socket.destroy();
			await fake.close();
		}
	});

	it("broadcasts session closure to observers while targeting the close response", async () => {
		const qa = scratch("close-observer");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			const opened = await a.peer.request({ id: "close-open", type: "open_session", cwd: qa.cwd });
			const sessionId = openedSessionId(opened);
			const observerClosed = b.peer.waitFor(
				(value) => value.type === "session_closed" && value.sessionId === sessionId,
			);
			const requesterResponse = a.peer.request({ id: "close-request", type: "close_session", sessionId });
			await expect(requesterResponse).resolves.toMatchObject({
				type: "response",
				command: "close_session",
				success: true,
				sessionId,
			});
			await expect(observerClosed).resolves.toMatchObject({ type: "session_closed", sessionId });
			expect(b.peer.messages.some((value) => value.id === "close-request")).toBe(false);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
			await fake.close();
		}
	});

	it("matches classic stdio JSONL for an identical command sequence modulo generated ids and routing tags", async () => {
		const socketQa = scratch("diff-socket");
		const stdioQa = scratch("diff-stdio");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(socketQa.agentDir, fake.origin);
		writeRpcModelsJson(stdioQa.agentDir, fake.origin);
		const socketChild = spawnRpc(
			[
				"--mode",
				"rpc",
				"--listen",
				`unix://${socketQa.socketPath}`,
				"--provider",
				MOCK_PROVIDER,
				"--model",
				MOCK_MODEL,
			],
			socketQa,
		);
		await waitForStderr(socketChild, `senpi rpc listening on unix://${socketQa.socketPath}`);
		const socket = await connectPeer(socketQa.socketPath);
		const stdioChild = spawnRpc(["--mode", "rpc", "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL], stdioQa);
		const stdio = new JsonlPeer(stdioChild.stdout, (line) => stdioChild.stdin.write(line));
		try {
			const opened = await socket.peer.request({ id: "setup-open", type: "open_session", cwd: socketQa.cwd });
			const sessionId = openedSessionId(opened);
			const commands = [
				{ id: "same-state", type: "get_state" },
				{ id: "same-messages", type: "get_messages" },
			] as const;
			const socketResponses: RecordValue[] = [];
			const stdioResponses: RecordValue[] = [];
			for (const command of commands) {
				socketResponses.push(await socket.peer.request({ ...command, sessionId }));
				stdioResponses.push(await stdio.request({ ...command }));
			}
			expect(socketResponses.map(normalizeResponse)).toEqual(stdioResponses.map(normalizeResponse));
		} finally {
			socket.peer.close();
			socket.socket.destroy();
			stdio.close();
			await fake.close();
		}
	});
});

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
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
