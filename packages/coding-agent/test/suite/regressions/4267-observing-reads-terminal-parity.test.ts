/**
 * senpi#4267: observing state and history reads, history tail paging, terminal endpoint parity.
 *
 * Host side: `get_entries { before?, tail? }` reads the newest entries first and walks back with `next_before`
 * under the same byte rule, and both capabilities are advertised. Terminal side: a terminal control endpoint
 * answers the host's observe-and-drive set (history, role declaration, live attachment, abort with the host's role
 * rule, input admission receipts and their replay) and advertises `tui_observer`. Protocol contract.
 */
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { multiSessionHostCapabilities } from "../../../src/modes/rpc/host-capabilities.ts";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { createHarness, type Harness } from "../harness.ts";

type WireRecord = Readonly<Record<string, unknown>>;
const cleanups: Array<() => unknown> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One persistent connection: every record it reads, and a wait for the next one matching a predicate. */
class Client {
	readonly records: WireRecord[] = [];
	private readonly waiters: Array<{ match: (r: WireRecord) => boolean; resolve: (r: WireRecord) => void }> = [];
	private next = 0;
	private readonly socket: Socket;
	private constructor(socket: Socket) {
		this.socket = socket;
		let buffer = "";
		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
				const record: WireRecord = JSON.parse(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				this.records.push(record);
				for (const waiter of [...this.waiters])
					if (waiter.match(record)) {
						this.waiters.splice(this.waiters.indexOf(waiter), 1);
						waiter.resolve(record);
					}
			}
		});
	}
	static async connect(path: string): Promise<Client> {
		const socket = createConnection(path);
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		socket.write(readFileSync(socketSecretPath(path)));
		const client = new Client(socket);
		cleanups.push(() => socket.destroy());
		return client;
	}
	request(command: WireRecord): Promise<WireRecord> {
		const id = `r${++this.next}`;
		const answer = this.waitFor((r) => r.type === "response" && r.id === id);
		this.socket.write(`${JSON.stringify({ ...command, id })}\n`);
		return answer;
	}
	waitFor(match: (r: WireRecord) => boolean): Promise<WireRecord> {
		const seen = this.records.find(match);
		if (seen !== undefined) return Promise.resolve(seen);
		return new Promise((resolve) => this.waiters.push({ match, resolve }));
	}
}

interface Held {
	readonly tool: AgentTool;
	readonly started: Promise<void>;
	release(): void;
}

function heldTool(): Held {
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	return {
		tool: {
			name: "hold",
			label: "Hold",
			description: "Holds the turn",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		},
		started: started.promise,
		release: () => gate.resolve(),
	};
}

async function terminal(tools: AgentTool[] = []): Promise<{ harness: Harness; socket: string }> {
	let socket: string | undefined;
	let inboxDir = "";
	const harness = await createHarness({
		persistSession: true,
		tools,
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					const registration = await pi.session.registerControlEndpoint({ inboxDir, drain: () => undefined });
					if (registration.status !== "registered") throw new Error(JSON.stringify(registration));
					cleanups.push(() => registration.dispose());
					socket = registration.socket;
				});
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	inboxDir = join(harness.tempDir, "inbox");
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	cleanups.push(() => ui.stop());
	const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
	if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
	await bind.call(mode);
	if (socket === undefined) throw new Error("the terminal registered no control endpoint");
	return { harness, socket };
}

const isDelta = (r: WireRecord): boolean => r.type === "message_update";
type Page = { entries: { id: string }[]; hasMore?: boolean; next_before?: string; nextSince?: string };

async function classic(turns: number) {
	const harness = await createHarness({ settings: { compaction: { enabled: false } } });
	cleanups.push(() => harness.cleanup());
	harness.setResponses(Array.from({ length: turns }, (_, turn) => fauxAssistantMessage(`answer ${turn}`)));
	for (let turn = 0; turn < turns; turn++) await harness.session.prompt(`request ${turn}`);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.session.agentDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("This fixture does not replace sessions");
		},
	);
	const records: WireRecord[] = [];
	const handler = createRpcConnectionHandler(runtime, {
		writeRaw(chunk) {
			for (const line of chunk.split("\n").filter(Boolean)) records.push(JSON.parse(line));
		},
		waitForBackpressure: async () => {},
	});
	await handler.ready;
	cleanups.push(() => handler.dispose());
	let next = 0;
	const ask = async (command: Record<string, unknown>): Promise<WireRecord> => {
		const id = `q${next++}`;
		await handler.handleInputLine(JSON.stringify({ ...command, id }));
		const answer = records.find((record) => record.id === id);
		if (answer === undefined) throw new Error(`no answer to ${id}`);
		return answer;
	};
	return { ids: harness.sessionManager.getEntries().map((entry) => entry.id), ask };
}

describe("get_entries tail paging (senpi#4267)", () => {
	it("answers the newest tail entries in append order, with next_before naming the oldest one", async () => {
		const { ids, ask } = await classic(4);

		const answer = await ask({ type: "get_entries", tail: 3 });

		expect(answer.success).toBe(true);
		const page = answer.data as Page;
		expect(page.entries.map((entry) => entry.id)).toEqual(ids.slice(-3));
		expect(page).toMatchObject({ hasMore: true, next_before: ids.at(-3) });
		expect(page).not.toHaveProperty("nextSince");
	});

	it("walks the whole history backwards with before: next_before until hasMore is false", async () => {
		const { ids, ask } = await classic(4);

		const pages: string[][] = [];
		let before: string | undefined;
		for (;;) {
			const answer = await ask({ type: "get_entries", tail: 2, ...(before === undefined ? {} : { before }) });
			const page = answer.data as Page;
			pages.unshift(page.entries.map((entry) => entry.id));
			if (!page.hasMore) {
				expect(page).not.toHaveProperty("next_before");
				break;
			}
			before = page.next_before;
		}

		expect(pages.flat()).toEqual(ids);
	});

	it("stops a tail page at maxBytes but always takes the newest entry", async () => {
		const { ids, ask } = await classic(2);

		const answer = await ask({ type: "get_entries", tail: 10, maxBytes: 1 });

		expect((answer.data as Page).entries.map((entry) => entry.id)).toEqual(ids.slice(-1));
		expect(answer.data).toMatchObject({ hasMore: true, next_before: ids.at(-1) });
	});

	it("bounds a forward read with before, and leaves since unchanged", async () => {
		const { ids, ask } = await classic(3);

		const bounded = await ask({ type: "get_entries", before: ids[3] });
		const forward = await ask({ type: "get_entries", since: ids[1] });

		expect((bounded.data as Page).entries.map((entry) => entry.id)).toEqual(ids.slice(0, 3));
		expect((forward.data as Page).entries.map((entry) => entry.id)).toEqual(ids.slice(2));
	});

	it("refuses an unknown before, a bad tail, and tail with limit", async () => {
		const { ask } = await classic(1);

		expect(await ask({ type: "get_entries", before: "missing" })).toMatchObject({
			success: false,
			errorCode: "not_found",
		});
		for (const bounds of [{ tail: 0 }, { tail: 1.5 }, { tail: 2, limit: 2 }])
			expect(await ask({ type: "get_entries", ...bounds })).toMatchObject({
				success: false,
				errorCode: "invalid_argument",
			});
	});

	it("advertises entries_tail on a classic connection, and observe_reads with it on a host", async () => {
		const { ask } = await classic(0);

		const info = await ask({ type: "get_protocol_info" });
		const host = multiSessionHostCapabilities({ warm: true, toolRuntime: "in-process", negotiated: [] });

		expect((info.data as { capabilities: string[] }).capabilities).toContain("entries_tail");
		expect(host).toEqual(expect.arrayContaining(["observe_reads", "entries_tail"]));
	});
});

describe("terminal control endpoint: observe and drive parity (senpi#4267)", () => {
	it("advertises tui_observer and lists the drive set in commands", async () => {
		const { socket } = await terminal();
		const client = await Client.connect(socket);

		const info = (await client.request({ type: "get_protocol_info", observe: true })).data as {
			capabilities: string[];
			commands: string[];
		};

		expect(info.capabilities).toEqual(expect.arrayContaining(["tui_observer", "observe_reads", "entries_tail"]));
		expect(info.commands).toEqual(
			expect.arrayContaining([
				"get_state",
				"get_entries",
				"subscribe_sessions",
				"set_client_info",
				"attach_session",
				"release_attachment",
				"prompt",
				"steer",
				"abort",
				"extension_ui_response",
			]),
		);
	});

	it("answers get_entries with the host's tail paging", async () => {
		const { harness, socket } = await terminal();
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const ids = harness.session.sessionManager.getEntries().map((entry) => entry.id);
		const client = await Client.connect(socket);

		const answer = await client.request({ type: "get_entries", tail: 2, observe: true });

		expect(answer).toMatchObject({ success: true, data: { hasMore: true, next_before: ids.at(-2) } });
		expect((answer.data as Page).entries.map((entry) => entry.id)).toEqual(ids.slice(-2));
	});

	it("mirrors a scripted turn's content to a mirror all subscriber that never attached", async () => {
		const { harness, socket } = await terminal();
		const client = await Client.connect(socket);

		const subscribed = await client.request({ type: "subscribe_sessions", sessions: "all", mirror: "all" });
		harness.setResponses([fauxAssistantMessage("mirrored to an observer")]);
		await harness.session.prompt("go");
		await harness.session.waitForSettledSessionWork();

		expect(subscribed).toMatchObject({ success: true });
		const delta = await client.waitFor(isDelta);
		expect(delta.sessionId).toBe(harness.session.sessionId);
		await client.waitFor((r) => r.type === "agent_end");
		const rows = (await client.request({ type: "subscribe_sessions", sessions: "all" })).data as {
			snapshot: WireRecord[];
		};
		expect(rows.snapshot[0]).toMatchObject({ attachments: 1 });
	});

	it("attaches with attach_session on the session's identity, and releases it with release_attachment", async () => {
		const { harness, socket } = await terminal();
		const client = await Client.connect(socket);
		const sessionId = harness.session.sessionId;

		const mismatch = await client.request({ type: "attach_session", sessionId, durableSessionId: "other" });
		const unknown = await client.request({ type: "attach_session", sessionId: "other", durableSessionId: sessionId });
		const attached = await client.request({ type: "attach_session", sessionId, durableSessionId: sessionId });
		harness.setResponses([fauxAssistantMessage("for the attached client")]);
		await harness.session.prompt("go");
		await client.waitFor(isDelta);
		const released = await client.request({ type: "release_attachment", sessionId });
		const again = await client.request({ type: "release_attachment", sessionId });

		expect(mismatch).toMatchObject({ success: false, errorCode: "session_identity_mismatch" });
		expect(unknown).toMatchObject({ success: false, errorCode: "unknown_session" });
		expect(attached).toMatchObject({ success: true, data: { sessionId, attached: true } });
		expect(released).toMatchObject({ success: true, data: { deferred: false } });
		expect(again).toMatchObject({ success: false, errorCode: "session_not_attached" });
	});

	it("refuses abort intent stop until the connection declares interactive_user, then stops the turn", async () => {
		const held = heldTool();
		const { harness, socket } = await terminal([held.tool]);
		const client = await Client.connect(socket);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("not reached"),
		]);
		const run = harness.session.prompt("start").catch(() => undefined);
		await held.started;

		const refused = await client.request({ type: "abort", intent: "stop" });
		const declared = await client.request({ type: "set_client_info", width: 80, capabilities: ["interactive_user"] });
		const changed = await client.request({ type: "set_client_info", width: 80, capabilities: [] });
		const stopped = await client.request({ type: "abort", intent: "stop" });
		held.release();
		await run;

		expect(refused).toMatchObject({
			success: false,
			error: "stop_requires_interactive_client: declare interactive_user with set_client_info first",
		});
		expect(declared).toMatchObject({ success: true });
		expect(changed).toMatchObject({ success: false, error: expect.stringContaining("connection_role_fixed") });
		expect(stopped).toMatchObject({ success: true, command: "abort" });
		expect(harness.session.isStreaming).toBe(false);
	});

	it("answers input with an admission receipt, and a replayed prompt with the same receipt marked replayed", async () => {
		const { harness, socket } = await terminal();
		const client = await Client.connect(socket);
		harness.setResponses([fauxAssistantMessage("answered once")]);
		const sessionId = harness.session.sessionId;

		const first = await client.request({ type: "prompt", message: "do it", clientMessageId: "c-1" });
		await harness.session.waitForSettledSessionWork();
		const replay = await client.request({ type: "prompt", message: "do it", clientMessageId: "c-1" });
		const conflict = await client.request({ type: "prompt", message: "something else", clientMessageId: "c-1" });

		const receipt = { clientMessageId: "c-1", durableSessionId: sessionId, disposition: "started" };
		expect(first).toMatchObject({
			success: true,
			data: { disposition: "started", clientMessageId: "c-1", admission: receipt },
		});
		expect(first.data).not.toHaveProperty("replayed");
		expect(replay).toMatchObject({
			success: true,
			data: { disposition: "started", clientMessageId: "c-1", replayed: true, admission: receipt },
		});
		expect(conflict).toMatchObject({ success: false, errorCode: "client_message_id_conflict" });
		expect(JSON.stringify(harness.session.messages).split("do it").length - 1).toBe(1);
	});
});
