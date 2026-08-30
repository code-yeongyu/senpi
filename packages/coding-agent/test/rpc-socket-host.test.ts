import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
					reject(new Error(`Timed out waiting for RPC record: ${JSON.stringify(this.messages)}`));
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
	return {
		root,
		agentDir,
		sessionDir,
		cwd,
		socketPath: join(root, "rpc.sock"),
	};
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
			SENPI_RPC_CLIENT_CAPABILITIES: "extension_events,custom_unsupported",
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
		delete data.cwd;
		if (Array.isArray(data.messages)) {
			data.messages = data.messages.map((message) => {
				if (typeof message !== "object" || message === null) return message;
				const normalized = { ...(message as RecordValue) };
				delete normalized.id;
				delete normalized.timestamp;
				return normalized;
			});
		}
		if (Array.isArray(data.entries)) {
			data.entries = data.entries.map((entry) => {
				if (typeof entry !== "object" || entry === null) return entry;
				const normalized = { ...(entry as RecordValue) };
				delete normalized.id;
				delete normalized.parentId;
				delete normalized.timestamp;
				if (normalized.data && typeof normalized.data === "object") {
					const entryData = { ...(normalized.data as RecordValue) };
					delete entryData.cwd;
					normalized.data = entryData;
				}
				return normalized;
			});
		}
	}
	return clone;
}

describe("RPC Unix-socket multi-connection host", () => {
	it("signals unsupported factory widgets while preserving array widgets", async () => {
		const qa = scratch("widget-factory");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "widget-factory.ts"),
			`export default function (pi) {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.setWidget("array-widget", ["array widget"]);
					ctx.ui.setWidget("factory-widget", () => ({ render: () => ["factory widget"] }));
				});
			}\n`,
		);
		const child = spawnRpc(
			[
				"--mode",
				"rpc",
				"--listen",
				`unix://${qa.socketPath}`,
				"--provider",
				MOCK_PROVIDER,
				"--model",
				MOCK_MODEL,
				"--extension",
				join(qa.agentDir, "extensions", "widget-factory.ts"),
			],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const peer = await connectPeer(qa.socketPath);
		try {
			const arrayWidget = peer.peer.waitFor(
				(value) =>
					value.type === "extension_ui_request" &&
					value.method === "setWidget" &&
					value.widgetKey === "array-widget",
				1_000,
			);
			const unsupported = peer.peer.waitFor(
				(value) => value.type === "extension_ui_request" && value.method === "custom_unsupported",
				1_000,
			);
			const opened = await peer.peer.request({ id: "open", type: "open_session", cwd: qa.cwd });
			const sessionId = openedSessionId(opened);
			expect(await arrayWidget).toMatchObject({
				type: "extension_ui_request",
				method: "setWidget",
				widgetKey: "array-widget",
				widgetLines: ["array widget"],
			});
			expect(await unsupported).toMatchObject({
				type: "extension_ui_request",
				method: "custom_unsupported",
				extensionName: "widget component",
				sessionId,
			});
		} finally {
			peer.peer.close();
			peer.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("dispatches a reentrant UI response while switch_session is in flight", async () => {
		const qa = scratch("reent");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "reentrant-ui.ts"),
			`export default function (pi) {
				pi.on("session_before_switch", async (_event, ctx) => {
					await ctx.ui.confirm("Reentrant switch", "Allow session switch?");
				});
			}\n`,
		);
		const child = spawnRpc(
			[
				"--mode",
				"rpc",
				"--listen",
				`unix://${qa.socketPath}`,
				"--provider",
				MOCK_PROVIDER,
				"--model",
				MOCK_MODEL,
				"--extension",
				join(qa.agentDir, "extensions", "reentrant-ui.ts"),
			],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const peer = await connectPeer(qa.socketPath);
		try {
			const opened = await peer.peer.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
			});
			const ui = peer.peer.waitFor(
				(value) => value.type === "extension_ui_request" && value.method === "confirm",
				5_000,
			);
			const switched = peer.peer.request(
				{
					id: "switch",
					type: "switch_session",
					sessionId: openedSessionId(opened),
					sessionPath: join(qa.sessionDir, "switch.jsonl"),
				},
				5_000,
			);
			const request = await ui;
			expect(request).toMatchObject({
				type: "extension_ui_request",
				method: "confirm",
			});
			peer.peer.write({
				type: "extension_ui_response",
				id: request.id,
				sessionId: openedSessionId(opened),
				confirmed: true,
			});
			await expect(switched).resolves.toMatchObject({
				success: true,
				command: "switch_session",
			});
			expect(opened).toMatchObject({ success: true });
		} finally {
			peer.peer.close();
			peer.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

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

			const opened = await a.peer.request({
				id: "open-a",
				type: "open_session",
				cwd: qa.cwd,
			});
			const sessionId = openedSessionId(opened);

			const settledA = a.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			const settledB = b.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			await expect(
				b.peer.request({
					id: "foreign-prompt",
					type: "prompt",
					sessionId,
					message: "unique-424242",
				}),
			).resolves.toMatchObject({ success: true, sessionId });
			await Promise.all([settledA, settledB]);

			const transcript = await b.peer.request({
				id: "foreign-transcript",
				type: "get_messages",
				sessionId,
			});
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
					reconnected.peer.request({
						id: "reconnected",
						type: "get_state",
						sessionId,
					}),
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
			const opened = await a.peer.request({
				id: "close-open",
				type: "open_session",
				cwd: qa.cwd,
			});
			const sessionId = openedSessionId(opened);
			const observerClosed = b.peer.waitFor(
				(value) => value.type === "session_closed" && value.sessionId === sessionId,
			);
			const requesterResponse = a.peer.request({
				id: "close-request",
				type: "close_session",
				sessionId,
			});
			await expect(requesterResponse).resolves.toMatchObject({
				type: "response",
				command: "close_session",
				success: true,
				sessionId,
			});
			await expect(observerClosed).resolves.toMatchObject({
				type: "session_closed",
				sessionId,
			});
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
			const opened = await socket.peer.request({
				id: "setup-open",
				type: "open_session",
				cwd: socketQa.cwd,
			});
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
	it("releases a dropped connection's session so the same path reopens fresh", async () => {
		const qa = scratch("drop-release");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const sessionPath = join(qa.sessionDir, "dropped.jsonl");
		const first = await connectPeer(qa.socketPath);
		try {
			const opened = await first.peer.request({
				id: "open-1",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(opened).toMatchObject({ success: true });
			expect((opened.data as RecordValue | undefined)?.attached ?? false).toBe(false);

			// Ungraceful drop: the terminal closed / the client was SIGKILLed, so no
			// close_session ever arrives. The host must still release what this
			// connection held, otherwise the path stays reserved by a runtime whose
			// client is gone and every later resume of it is wrong.
			first.peer.close();
			first.socket.destroy();
			await new Promise((resolve) => setTimeout(resolve, 500));
		} finally {
			first.socket.destroy();
		}

		const second = await connectPeer(qa.socketPath);
		try {
			const reopened = await second.peer.request({
				id: "open-2",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(reopened).toMatchObject({ success: true });
			// A fresh open, NOT an attach to the orphaned runtime.
			expect((reopened.data as RecordValue | undefined)?.attached ?? false).toBe(false);
			await expect(
				second.peer.request({
					id: "close-2",
					type: "close_session",
					sessionId: openedSessionId(reopened),
				}),
			).resolves.toMatchObject({ success: true });
		} finally {
			second.peer.close();
			second.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("keeps the surviving attachment bound after the other explicitly closes", async () => {
		const qa = scratch("att");
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
			const opened = await a.peer.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: join(qa.sessionDir, "att.jsonl"),
			});
			const sessionId = openedSessionId(opened);
			await expect(
				b.peer.request({
					id: "attach",
					type: "open_session",
					cwd: qa.cwd,
					sessionPath: join(qa.sessionDir, "att.jsonl"),
				}),
			).resolves.toMatchObject({ success: true });
			await expect(a.peer.request({ id: "close-a", type: "close_session", sessionId })).resolves.toMatchObject({
				success: true,
			});
			const event = b.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			await expect(
				b.peer.request({
					id: "prompt-b",
					type: "prompt",
					sessionId,
					message: "survivor",
				}),
			).resolves.toMatchObject({ success: true });
			await expect(event).resolves.toMatchObject({ sessionId });
			expect(
				b.peer.messages.filter((value) => value.type === "agent_settled" && value.sessionId === sessionId),
			).toHaveLength(1);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("does not close or stop events for the surviving attachment", async () => {
		const qa = scratch("live");
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
			const path = join(qa.sessionDir, "live.jsonl");
			const opened = await a.peer.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: path,
			});
			const sessionId = openedSessionId(opened);
			await b.peer.request({
				id: "attach",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: path,
			});
			await a.peer.request({ id: "close", type: "close_session", sessionId });
			await expect(b.peer.request({ id: "state", type: "get_state", sessionId })).resolves.toMatchObject({
				success: true,
			});
			expect(b.peer.messages.some((value) => value.type === "session_closed" && value.sessionId === sessionId)).toBe(
				false,
			);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("reopens the path after explicit close and dropped surviving attachment", async () => {
		const qa = scratch("reopen");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		const path = join(qa.sessionDir, "reopen.jsonl");
		try {
			const opened = await a.peer.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: path,
			});
			const sessionId = openedSessionId(opened);
			await b.peer.request({
				id: "attach",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath: path,
			});
			await a.peer.request({ id: "close", type: "close_session", sessionId });
			b.peer.close();
			b.socket.destroy();
			await new Promise((resolve) => setTimeout(resolve, 100));
			const c = await connectPeer(qa.socketPath);
			try {
				await expect(
					c.peer.request({
						id: "fresh",
						type: "open_session",
						cwd: qa.cwd,
						sessionPath: path,
					}),
				).resolves.toMatchObject({ success: true });
				expect(
					(c.peer.messages.find((value) => value.id === "fresh")?.data as RecordValue | undefined)?.attached ??
						false,
				).toBe(false);
			} finally {
				c.peer.close();
				c.socket.destroy();
			}
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("keeps a co-attached session alive when one of its connections drops", async () => {
		const qa = scratch("drop-survivor");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const sessionPath = join(qa.sessionDir, "shared.jsonl");
		const holder = await connectPeer(qa.socketPath);
		const dropper = await connectPeer(qa.socketPath);
		try {
			const held = await holder.peer.request({
				id: "open-hold",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(held).toMatchObject({ success: true });
			const heldId = openedSessionId(held);

			const attached = await dropper.peer.request({
				id: "open-attach",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
			});
			expect(attached).toMatchObject({ success: true });
			expect((attached.data as RecordValue | undefined)?.attached).toBe(true);

			// Only the second attachment dies. The runtime is refcounted, so the
			// holder must keep serving commands on its own handle.
			dropper.peer.close();
			dropper.socket.destroy();
			await new Promise((resolve) => setTimeout(resolve, 500));

			await expect(
				holder.peer.request({
					id: "probe-hold",
					type: "get_protocol_info",
					sessionId: heldId,
				}),
			).resolves.toMatchObject({ success: true });
			await expect(
				holder.peer.request({
					id: "close-hold",
					type: "close_session",
					sessionId: heldId,
				}),
			).resolves.toMatchObject({ success: true });
		} finally {
			holder.peer.close();
			holder.socket.destroy();
			dropper.socket.destroy();
			await fake.close();
			await stopChild(child);
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
