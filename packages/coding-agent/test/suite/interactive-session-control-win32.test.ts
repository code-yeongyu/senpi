/**
 * The interactive TUI on win32 - the platform cell of the terminal control endpoint contract (senpi#4267).
 *
 * A terminal registers its control endpoint on win32 as on POSIX: the socket path is the logical address, the
 * 32-byte secret sits beside it, and the listener binds the named pipe the host transport derives from both. The
 * endpoint appears in `senpi host status --all` as a live `tui` row, and a client that sent the secret attaches and
 * drives the session over the pipe: declare the user's role, attach on the session's identity, prompt, read the
 * turn's records and stop a turn.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import type { SessionControlRegistration } from "../../src/core/extensions/session-control-types.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { readAllHostStatus } from "../../src/modes/rpc/host-status-all.ts";
import { resolveSocketTransportAddress, socketSecretPath } from "../../src/modes/rpc/socket-transport.ts";
import { createHarness, type Harness } from "./harness.ts";

type WireRecord = Readonly<Record<string, unknown>>;
const cleanups: Array<() => unknown> = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startInteractive(harness: Harness): Promise<void> {
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	cleanups.push(() => ui.stop());
	const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
	if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
	await bind.call(mode);
}

/** One connection over the endpoint's named pipe: every record it reads, and a wait for the next match. */
class PipeClient {
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
	static async connect(logicalPath: string): Promise<PipeClient> {
		const secret = readFileSync(socketSecretPath(logicalPath));
		const address = resolveSocketTransportAddress(logicalPath, process.platform, secret);
		expect(address.startsWith("\\\\.\\pipe\\")).toBe(true);
		const socket = createConnection(address);
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		socket.write(secret);
		cleanups.push(() => socket.destroy());
		return new PipeClient(socket);
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

function heldTool(): { tool: AgentTool; started: Promise<void>; release(): void } {
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

describe.skipIf(process.platform !== "win32")("interactive TUI control endpoint on win32", () => {
	it("registers over a named pipe, is listed by host status --all, and is attached and driven", async () => {
		const held = heldTool();
		const registrations: SessionControlRegistration[] = [];
		let inboxDir = "";
		const harness = await createHarness({
			persistSession: true,
			tools: [held.tool],
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						const registration = await pi.session.registerControlEndpoint({ inboxDir, drain: () => undefined });
						if (registration.status === "registered") cleanups.push(() => registration.dispose());
						registrations.push(registration);
					});
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		inboxDir = join(harness.tempDir, "inbox");
		const agentDir = harness.session.agentDir;

		await startInteractive(harness);

		const registration = registrations[0];
		expect(registration).toMatchObject({ status: "registered" });
		if (registration?.status !== "registered") throw new Error(JSON.stringify(registrations));
		const rows = await readAllHostStatus({ agentDir, includeWorkers: false });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ endpoint_kind: "tui", alive: true });

		const client = await PipeClient.connect(registration.socket);
		const sessionId = harness.session.sessionId;
		const info = await client.request({ type: "get_protocol_info", observe: true });
		const declared = await client.request({ type: "set_client_info", width: 80, capabilities: ["interactive_user"] });
		const attached = await client.request({ type: "attach_session", sessionId, durableSessionId: sessionId });
		harness.setResponses([
			fauxAssistantMessage("served over a pipe"),
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("not reached"),
		]);
		const prompted = await client.request({ type: "prompt", message: "hello", clientMessageId: "w-1" });
		await client.waitFor((r) => r.type === "agent_end");
		await harness.session.waitForSettledSessionWork();
		const run = harness.session.prompt("hold it").catch(() => undefined);
		await held.started;
		const stopped = await client.request({ type: "abort", intent: "stop" });
		held.release();
		await run;

		expect((info.data as { capabilities: string[] }).capabilities).toContain("tui_observer");
		expect(declared).toMatchObject({ success: true });
		expect(attached).toMatchObject({ success: true, data: { sessionId, attached: true } });
		expect(prompted).toMatchObject({ success: true, data: { disposition: "started", clientMessageId: "w-1" } });
		expect(client.records.some((r) => r.type === "message_update")).toBe(true);
		expect(stopped).toMatchObject({ success: true, command: "abort" });
		expect(harness.session.isStreaming).toBe(false);
	});
});
