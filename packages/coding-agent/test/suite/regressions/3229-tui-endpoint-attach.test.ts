/**
 * senpi#3229: a terminal control endpoint serves its own session the way a host does. A client attaches by
 * path and reads the session's records (the host's projection and replay), steers through the terminal's
 * admission with the host's `whenIdle` meaning, and subscribes to the status stream, with content only
 * for a client that attached or asked for it with `mirror`. A real interactive mode (virtual terminal)
 * registers the endpoint at session start, as OmO's thread component does.
 */
import { readFileSync, symlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
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

describe("terminal control endpoint serves its session like a host (senpi#3229)", () => {
	it("attaches by path, then streams the session's records while the terminal runs a turn", async () => {
		const { harness, socket } = await terminal();
		await harness.session.sessionManager.persistHeaderNow();
		const client = await Client.connect(socket);

		const opened = await client.request({ type: "open_session", sessionPath: harness.session.sessionFile });
		harness.setResponses([fauxAssistantMessage("streamed from the terminal")]);
		await harness.session.prompt("go");

		expect(opened).toMatchObject({ success: true, data: { attached: true, sessionId: harness.session.sessionId } });
		expect((opened.data as WireRecord).state).toMatchObject({ sessionId: harness.session.sessionId });
		const delta = await client.waitFor(isDelta);
		expect(delta.sessionId).toBe(harness.session.sessionId);
		expect(client.records.indexOf(opened)).toBeLessThan(client.records.indexOf(delta));
	});

	it("opens its session through a symlinked spelling of the path, and a repeat open stays attached once", async () => {
		const { harness, socket } = await terminal();
		await harness.session.sessionManager.persistHeaderNow();
		const own = harness.session.sessionFile ?? "";
		const link = join(harness.tempDir, "linked-sessions");
		symlinkSync(dirname(own), link);
		const client = await Client.connect(socket);

		const first = await client.request({ type: "open_session", sessionPath: join(link, basename(own)) });
		const again = await client.request({ type: "open_session", sessionPath: own });
		const rows = (await client.request({ type: "subscribe_sessions", sessions: "all" })).data as {
			snapshot: WireRecord[];
		};

		expect(first).toMatchObject({ success: true, data: { attached: true } });
		expect(again).toMatchObject({ success: true, data: { attached: true } });
		expect(rows.snapshot[0]).toMatchObject({ attachments: 2 });
	});

	it("refuses input fields its admission cannot carry, naming them, and delivers nothing", async () => {
		const { harness, socket } = await terminal();
		const client = await Client.connect(socket);

		const answer = await client.request({
			type: "steer",
			message: "look",
			images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
		});

		expect(answer).toMatchObject({ success: false, errorCode: "unsupported_field" });
		expect(String(answer.error)).toContain("images");
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("refuses to open a session the terminal does not host", async () => {
		const { socket } = await terminal();
		const client = await Client.connect(socket);

		const answer = await client.request({ type: "open_session", sessionPath: "/elsewhere/other.jsonl" });

		expect(answer).toMatchObject({ success: false, errorCode: "terminal_single_session" });
	});

	it("lands a client steer in the running turn, and queues an idle default steer without starting a turn", async () => {
		const held = heldTool();
		const { harness, socket } = await terminal([held.tool]);
		const client = await Client.connect(socket);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("saw the steer"),
		]);
		const run = harness.session.prompt("start");
		await held.started;

		const steered = await client.request({ type: "steer", message: "steer from a client" });
		held.release();
		await run;
		await harness.session.waitForSettledSessionWork();
		let starts = 0;
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") starts += 1;
		});
		const idle = await client.request({ type: "steer", message: "for the next turn" });
		await harness.session.waitForIdle();

		expect(steered).toMatchObject({ success: true, data: { disposition: "queued" } });
		const texts = JSON.stringify(harness.session.messages);
		expect(texts).toContain("steer from a client");
		expect(idle).toMatchObject({ success: true, data: { disposition: "queued" } });
		expect(starts).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("streams status to a subscriber, and content only with mirror, without counting it as attached", async () => {
		const { harness, socket } = await terminal();
		const plain = await Client.connect(socket);
		const mirrored = await Client.connect(socket);

		const subscribed = await plain.request({ type: "subscribe_sessions", sessions: "all" });
		const mirroring = await mirrored.request({
			type: "subscribe_sessions",
			sessions: "all",
			mirror: ["message_update"],
		});
		harness.setResponses([fauxAssistantMessage("mirrored text")]);
		await harness.session.prompt("go");
		await harness.session.waitForSettledSessionWork();

		const snapshot = (subscribed.data as { snapshot: WireRecord[] }).snapshot;
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]).toMatchObject({ sessionId: harness.session.sessionId, attachments: 1 });
		expect(mirroring).toMatchObject({ success: true });
		await mirrored.waitFor(isDelta);
		await plain.waitFor((r) => r.type === "session_status" && r.status === "idle");
		expect(plain.records.some(isDelta)).toBe(false);
		const rows = (await plain.request({ type: "subscribe_sessions", sessions: "all" })).data as {
			snapshot: WireRecord[];
		};
		expect(rows.snapshot[0]).toMatchObject({ attachments: 1 });
	});
});
