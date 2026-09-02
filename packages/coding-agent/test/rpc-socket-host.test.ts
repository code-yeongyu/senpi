import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
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
		const pending = new Promise<RecordValue>((resolve, reject) => {
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
		// Callers arm a waiter BEFORE the command that triggers it and await it only
		// after that command returns, so anything rejecting in between - the timeout
		// or close() during teardown - rejects a promise with no handler attached
		// yet. Node then reports an unhandled rejection blamed on whichever test
		// happened to be running when the timer fired. Marking the promise handled at
		// creation closes that window for good; the rejection still propagates to the
		// eventual awaiter, so failures are surfaced rather than swallowed.
		pending.catch(() => {});
		return pending;
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

function spawnRpc(
	args: string[],
	qa: ReturnType<typeof scratch>,
	capabilities = "extension_events,custom_unsupported,rendered_components",
): ChildProcessWithoutNullStreams {
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
			SENPI_RPC_CLIENT_CAPABILITIES: capabilities,
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

/**
 * Observe whether Node reports an unhandled rejection while `body` runs.
 *
 * Subscribes before triggering, then waits for either the rejection event or a
 * bounded deadline, so the check never depends on a fixed sleep landing after
 * the microtask checkpoint.
 */
async function unhandledRejectionDuring(body: () => void, settleMs = 250): Promise<unknown> {
	let onUnhandled!: (reason: unknown) => void;
	const observed = new Promise<unknown>((resolve) => {
		onUnhandled = (reason: unknown) => resolve(reason);
		process.on("unhandledRejection", onUnhandled);
		setTimeout(() => resolve(undefined), settleMs);
	});
	try {
		body();
		return await observed;
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("JSONL peer waiter lifecycle", () => {
	// Every waiter in this suite is armed BEFORE the command that triggers it and
	// awaited only after that command returns. Whatever rejects in that window -
	// the timeout, or close() during teardown - rejects a promise nobody is
	// holding yet. A longer timeout only narrows the window; the rejection must be
	// handled from the moment the waiter exists.
	it("does not surface an unhandled rejection when an armed waiter times out before it is awaited", async () => {
		const peer = new JsonlPeer(new PassThrough(), () => {});
		let pending!: Promise<RecordValue>;

		const reason = await unhandledRejectionDuring(() => {
			pending = peer.waitFor(() => false, 1);
		});

		expect(reason).toBeUndefined();
		// The rejection still reaches the eventual awaiter; it is handled, not swallowed.
		await expect(pending).rejects.toThrow(/Timed out waiting for RPC record/);
	});

	it("does not surface an unhandled rejection when close() settles an armed waiter", async () => {
		const peer = new JsonlPeer(new PassThrough(), () => {});
		let pending!: Promise<RecordValue>;

		const reason = await unhandledRejectionDuring(() => {
			pending = peer.waitFor(() => false, 60_000);
			peer.close();
		});

		expect(reason).toBeUndefined();
		await expect(pending).rejects.toThrow(/RPC peer closed/);
	});

	it("still resolves a waiter armed before the matching record arrives", async () => {
		const stream = new PassThrough();
		const peer = new JsonlPeer(stream, () => {});

		const pending = peer.waitFor((value) => value.type === "late", 15_000);
		stream.write(`${JSON.stringify({ type: "late", ok: true })}\n`);

		expect(await pending).toMatchObject({ type: "late", ok: true });
	});
});

describe("RPC Unix-socket multi-connection host", () => {
	it("renders factory widgets while preserving array widgets", async () => {
		const qa = scratch("widget-factory");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "widget-factory.ts"),
			`export default function (pi) {
				pi.on("session_start", (_event, ctx) => {
					ctx.ui.setWidget("array-widget", ["array widget"]);
					ctx.ui.setWidget("factory-widget", () => ({ render: (width) => [\`w:\${width}\`] }));
					ctx.ui.setHeader(() => ({ render: () => ["factory header"] }));
					ctx.ui.setFooter((_tui, _theme, footerData) => ({ render: () => [footerData.getGitBranch() ?? "factory footer"] }));
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
			// Armed before open_session so neither request can be missed, but left on
			// the default timeout: both only arrive after the session spawns and loads
			// its extensions, which outruns a 1s budget on a loaded CI shard. A short
			// deadline here rejected both waiters and surfaced as two unhandled
			// rejections attributed to whichever test ran next.
			const arrayWidget = peer.peer.waitFor(
				(value) =>
					value.type === "extension_ui_request" &&
					value.method === "setWidget" &&
					value.widgetKey === "array-widget",
			);
			const factoryWidget = peer.peer.waitFor(
				(value) =>
					value.type === "extension_ui_request" &&
					value.method === "setWidget" &&
					value.widgetKey === "factory-widget",
			);
			const factoryHeader = peer.peer.waitFor(
				(value) =>
					value.type === "extension_ui_request" &&
					value.method === "setHeader" &&
					Array.isArray(value.widgetLines),
			);
			const factoryFooter = peer.peer.waitFor(
				(value) =>
					value.type === "extension_ui_request" &&
					value.method === "setFooter" &&
					Array.isArray(value.widgetLines),
			);
			await expect(
				peer.peer.request({
					id: "client-info",
					type: "set_client_info",
					width: 80,
					capabilities: ["rendered_components"],
				}),
			).resolves.toMatchObject({ type: "response", command: "set_client_info", success: true });
			const opened = await peer.peer.request({ id: "open", type: "open_session", cwd: qa.cwd });
			const sessionId = openedSessionId(opened);
			expect(await arrayWidget).toMatchObject({
				type: "extension_ui_request",
				method: "setWidget",
				widgetKey: "array-widget",
				widgetLines: ["array widget"],
			});
			expect(await factoryWidget).toMatchObject({
				type: "extension_ui_request",
				method: "setWidget",
				widgetKey: "factory-widget",
				widgetLines: ["w:80"],
				sessionId,
			});
			const resizedWidget = peer.peer.waitFor(
				(value) =>
					value.type === "extension_ui_request" &&
					value.method === "setWidget" &&
					value.widgetKey === "factory-widget" &&
					JSON.stringify(value.widgetLines) === JSON.stringify(["w:120"]),
			);
			await expect(
				peer.peer.request({ id: "set-width", type: "set_client_info", width: 120, sessionId }),
			).resolves.toMatchObject({
				type: "response",
				command: "set_client_info",
				success: true,
				sessionId,
			});
			expect(await resizedWidget).toMatchObject({
				type: "extension_ui_request",
				method: "setWidget",
				widgetKey: "factory-widget",
				widgetLines: ["w:120"],
				sessionId,
			});
			expect(await factoryHeader).toMatchObject({
				type: "extension_ui_request",
				method: "setHeader",
				widgetLines: ["factory header"],
				sessionId,
			});
			expect(await factoryFooter).toMatchObject({
				type: "extension_ui_request",
				method: "setFooter",
				widgetLines: ["factory footer"],
				sessionId,
			});
			expect(peer.peer.messages.some((value) => value.method === "custom_unsupported")).toBe(false);
		} finally {
			peer.peer.close();
			peer.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("keeps factory UI silent for a default client while preserving array widgets", async () => {
		const qa = scratch("widget-default");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "widget-factory.ts"),
			`export default function (pi) {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.setWidget("array-widget", ["array widget"]);
				ctx.ui.setWidget("factory-widget", () => ({ render: () => ["factory"] }));
				ctx.ui.setHeader(() => ({ render: () => ["header"] }));
				ctx.ui.setFooter((_tui, _theme, footerData) => ({ render: () => [footerData.getGitBranch() ?? "footer"] }));
			});
		}`,
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
			"rendered_components",
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const peer = await connectPeer(qa.socketPath);
		try {
			const opened = await peer.peer.request({ id: "open", type: "open_session", cwd: qa.cwd });
			await new Promise<void>((resolve) => queueMicrotask(resolve));
			expect(opened).toMatchObject({ success: true });
			expect(
				peer.peer.messages.filter(
					(value) =>
						value.type === "extension_ui_request" &&
						["factory-widget", "setHeader", "setFooter"].includes(String(value.widgetKey ?? value.method)),
				),
			).toEqual([]);
			expect(peer.peer.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						method: "setWidget",
						widgetKey: "array-widget",
						widgetLines: ["array widget"],
					}),
				]),
			);
		} finally {
			peer.peer.close();
			peer.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("preserves registered capabilities when one socket opens a second session", async () => {
		const qa = scratch("cap-second");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "widget-factory.ts"),
			`export default function (pi) { pi.on("session_start", (_event, ctx) => ctx.ui.setWidget("factory", () => ({ render: (width) => [String(width)] }))); }`,
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
			"rendered_components",
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const peer = await connectPeer(qa.socketPath);
		try {
			const first = await peer.peer.request({ id: "open-a", type: "open_session", cwd: qa.cwd });
			const sessionA = openedSessionId(first);
			await peer.peer.request({
				id: "info-a",
				type: "set_client_info",
				sessionId: sessionA,
				width: 80,
				capabilities: ["rendered_components"],
			});
			await peer.peer.request({ id: "open-b", type: "open_session", cwd: qa.cwd });
			const factoryAfterSecondOpen = peer.peer.waitFor(
				(value) =>
					value.type === "extension_ui_request" &&
					value.widgetKey === "factory" &&
					JSON.stringify(value.widgetLines) === JSON.stringify(["81"]),
			);
			await peer.peer.request({ id: "info-a-again", type: "set_client_info", sessionId: sessionA, width: 81 });
			expect(await factoryAfterSecondOpen).toMatchObject({
				sessionId: sessionA,
				widgetKey: "factory",
				widgetLines: ["81"],
			});
		} finally {
			peer.peer.close();
			peer.socket.destroy();
			await fake.close();
			await stopChild(child);
		}
	});

	it("uses the minimum reported width across attached peers and drops leavers", async () => {
		const qa = scratch("widget-width-peers");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		mkdirSync(join(qa.agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(qa.agentDir, "extensions", "widget-factory.ts"),
			`export default function (pi) { pi.on("session_start", (_event, ctx) => ctx.ui.setWidget("factory-widget", () => ({ render: (width) => [String(width)] }))); }`,
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
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			const path = join(qa.sessionDir, "width.jsonl");
			const opened = await a.peer.request({ id: "open", type: "open_session", cwd: qa.cwd, sessionPath: path });
			const sessionId = openedSessionId(opened);
			await b.peer.request({ id: "attach", type: "open_session", cwd: qa.cwd, sessionPath: path });
			await a.peer.request({
				id: "a-width",
				type: "set_client_info",
				width: 120,
				capabilities: ["rendered_components"],
				sessionId,
			});
			const min60 = a.peer.waitFor(
				(v) =>
					v.type === "extension_ui_request" &&
					v.widgetKey === "factory-widget" &&
					JSON.stringify(v.widgetLines) === JSON.stringify(["60"]),
			);
			await b.peer.request({
				id: "b-width",
				type: "set_client_info",
				width: 60,
				capabilities: ["rendered_components"],
				sessionId,
			});
			await expect(min60).resolves.toBeDefined();
			expect(
				b.peer.messages.some(
					(v) => v.widgetKey === "factory-widget" && JSON.stringify(v.widgetLines) === JSON.stringify(["60"]),
				),
			).toBe(true);
			const bClose = a.peer.waitFor(
				(v) =>
					v.type === "extension_ui_request" &&
					v.widgetKey === "factory-widget" &&
					JSON.stringify(v.widgetLines) === JSON.stringify(["120"]),
			);
			await b.peer.request({ id: "b-close", type: "close_session", sessionId });
			await expect(bClose).resolves.toBeDefined();
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
			b.socket.destroy();
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

	it("delivers foreign commands only after attachment, survives malformed frames, and reconnects", async () => {
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
			await expect(
				b.peer.request({
					id: "foreign-prompt",
					type: "prompt",
					sessionId,
					message: "unique-424242",
				}),
			).resolves.toMatchObject({ success: true, sessionId });
			await settledA;
			expect(b.peer.messages.some((value) => value.type === "agent_settled" && value.sessionId === sessionId)).toBe(
				false,
			);

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

	it("isolates a mid-turn session from attached and unattached raw sockets", async () => {
		const qa = scratch("mid-turn-isolation");
		const secondCwd = join(qa.root, "second-work");
		mkdirSync(secondCwd, { recursive: true });
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
			const openedA = await a.peer.request({ id: "open-p1", type: "open_session", cwd: qa.cwd });
			const openedB = await b.peer.request({ id: "open-p2", type: "open_session", cwd: secondCwd });
			const sessionB = openedSessionId(openedB);
			const turnStarted = b.peer.waitFor((value) => value.type === "message_start" && value.sessionId === sessionB);
			const turn = b.peer.request({
				id: "prompt-p2",
				type: "prompt",
				sessionId: sessionB,
				message: "isolation-turn",
			});
			await turnStarted;
			const third = await connectPeer(qa.socketPath);
			try {
				await turn;
				const foreign = (value: RecordValue) => value.sessionId === sessionB && value.type !== "session_closed";
				expect(a.peer.messages.some(foreign)).toBe(false);
				expect(third.peer.messages.some(foreign)).toBe(false);
			} finally {
				third.peer.close();
				third.socket.destroy();
			}
			expect(openedSessionId(openedA)).not.toBe(sessionB);
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.peer.close();
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
