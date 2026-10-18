/**
 * A client-less retained session keeps its permission preset when the SUCCESSOR host reopens it from
 * the handover-parked record and a client later attaches without naming one (senpi#3364).
 * The fake model ends a turn only when the LAST message carries the tool_result, so a reopened
 * session with older tool results in its history still makes a fresh gated call (senpi#3363).
 */
import { realpathSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { JsonlPeer, openedSessionId, type WireRecord } from "./helpers/rpc-generation-support.ts";
import { MOCK_MODEL } from "./helpers/rpc-hermetic.ts";
import {
	type EndpointScratch,
	endpointScratch,
	hostArgs,
	hostEnv,
	realHost,
	supervisorLaunch,
	sweepEndpointScratches,
	tracked,
	trackSupervisor,
} from "./helpers/rpc-host-endpoint-scratch.ts";

const FIXTURE_EXTENSION = join(import.meta.dirname, "helpers", "rpc-parked-preset-probe-extension.ts");

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
afterEach(sweepEndpointScratches, 180_000);

function writeSse(res: ServerResponse, events: ReadonlyArray<readonly [string, Record<string, unknown>]>): void {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	for (const [event, data] of events)
		res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	res.end();
}

const start = (): readonly [string, Record<string, unknown>] => [
	"message_start",
	{
		message: {
			id: "msg-parked-preset",
			type: "message",
			role: "assistant",
			model: MOCK_MODEL,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
];

function lastMessageHasToolResult(raw: string): boolean {
	const body = JSON.parse(raw) as { messages?: Array<{ content?: unknown }> };
	const content = body.messages?.at(-1)?.content;
	return Array.isArray(content) && content.some((part) => (part as { type?: string }).type === "tool_result");
}

let toolCalls = 0;
async function startProbeModel(): Promise<string> {
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			if (!req.url?.includes("/messages")) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "no route" } }));
				return;
			}
			if (lastMessageHasToolResult(raw)) {
				writeSse(res, [
					start(),
					["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
					["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }],
					["content_block_stop", { index: 0 }],
					[
						"message_delta",
						{ delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
					],
					["message_stop", {}],
				]);
				return;
			}
			toolCalls += 1;
			writeSse(res, [
				start(),
				[
					"content_block_start",
					{
						index: 0,
						content_block: {
							type: "tool_use",
							id: `toolu_parked_${toolCalls}`,
							name: "shell_fixture",
							input: {},
						},
					},
				],
				[
					"content_block_delta",
					{
						index: 0,
						delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo parked" }) },
					},
				],
				["content_block_stop", { index: 0 }],
				["message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
				["message_stop", {}],
			]);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("probe model did not bind a port");
	return `http://127.0.0.1:${address.port}`;
}

let counter = 0;
const nextId = (label: string): string => `${label}-${++counter}`;

/** One gated turn; answers each permission prompt with "Allow once" and counts them. */
async function probeTurn(peer: JsonlPeer, sessionId: string): Promise<{ prompts: number; toolCallsMade: number }> {
	peer.messages.length = 0;
	const callsBefore = toolCalls;
	const isTerminal = (record: WireRecord): boolean =>
		(record.type === "extension_ui_request" && record.method === "select") ||
		(record.type === "agent_end" && record.sessionId === sessionId);
	const first = peer.waitFor(isTerminal, 90_000);
	await peer.request({ id: nextId("prompt"), type: "prompt", sessionId, message: "probe" });
	let prompts = 0;
	let record = await first;
	while (record.type !== "agent_end") {
		prompts += 1;
		peer.messages.length = 0;
		const next = peer.waitFor(isTerminal, 90_000);
		peer.send({ type: "extension_ui_response", id: String(record.id), sessionId, value: "Allow once" });
		record = await next;
	}
	return { prompts, toolCallsMade: toolCalls - callsBefore };
}

async function openSession(
	peer: JsonlPeer,
	profile: Record<string, unknown>,
): Promise<{ sessionId: string; sessionPath: string }> {
	const opened = await peer.request({ id: nextId("open"), type: "open_session", ...profile });
	if (opened.success !== true) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
	const data = opened.data as { sessionPath?: string; state?: { sessionFile?: string } };
	const sessionPath = data.sessionPath ?? data.state?.sessionFile;
	if (typeof sessionPath !== "string") throw new Error(`open_session had no session path: ${JSON.stringify(opened)}`);
	return { sessionId: openedSessionId(opened), sessionPath };
}

async function handover(qa: EndpointScratch): Promise<void> {
	const before = await probeHost({ socket: qa.legacy });
	const result = await handoffHost({
		socket: qa.legacy,
		agentDir: qa.agentDir,
		hostArgs: hostArgs(FIXTURE_EXTENSION),
		env: hostEnv(qa),
		_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
	});
	if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
	trackSupervisor(result.pid);
	const after = await probeHost({ socket: qa.legacy });
	if (after?.instanceId === before?.instanceId) throw new Error("handoff kept the same host instance");
}

/** Waits until the successor itself has the parked session open again, before any client attaches. */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

async function waitForSuccessorReopen(qa: EndpointScratch, sessionPath: string): Promise<void> {
	// The host lists canonical paths (macOS resolves /var to /private/var), so compare canonically.
	const canonical = canonicalPath(sessionPath);
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const lister = await JsonlPeer.connect(qa.legacy);
		try {
			const listed = (await lister.request({
				id: nextId("list"),
				type: "list_sessions",
				include_workers: true,
			})) as WireRecord;
			const rows = (listed.data as { sessions?: Array<{ sessionPath?: string; status?: string }> })?.sessions ?? [];
			if (
				rows.some(
					(row) =>
						row.sessionPath !== undefined &&
						canonicalPath(row.sessionPath) === canonical &&
						row.status === "open",
				)
			)
				return;
		} finally {
			lister.destroy();
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`the successor never reopened ${sessionPath}`);
}

async function parkSessionAndHandOver(
	label: string,
	permissionPreset: "ask" | "full-access",
): Promise<{ qa: EndpointScratch; sessionPath: string }> {
	const origin = await startProbeModel();
	const qa = endpointScratch(label, origin);
	await realHost(qa, qa.legacy, { extension: FIXTURE_EXTENSION });
	const opener = await JsonlPeer.connect(qa.legacy);
	tracked.peers.push(opener);
	const opened = await openSession(opener, { cwd: qa.cwd, permissionPreset, retain_on_disconnect: true });
	const before = await probeTurn(opener, opened.sessionId);
	expect(before.toolCallsMade).toBe(1);
	expect(before.prompts).toBe(permissionPreset === "ask" ? 1 : 0);
	opener.destroy();
	await handover(qa);
	await waitForSuccessorReopen(qa, opened.sessionPath);
	return { qa, sessionPath: opened.sessionPath };
}

describe.skipIf(process.platform === "win32")("a parked session reopened by the successor keeps its preset", () => {
	it("ask still asks when a client attaches without naming a preset", async () => {
		const { qa, sessionPath } = await parkSessionAndHandOver("hpp-ask", "ask");
		const attacher = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(attacher);
		const attached = await openSession(attacher, { cwd: qa.cwd, sessionPath });
		const after = await probeTurn(attacher, attached.sessionId);
		expect(after.toolCallsMade).toBe(1);
		expect(after.prompts, "the reopened ask session ran a gated tool without asking").toBe(1);
	}, 300_000);

	it("full-access never asks when a client attaches without naming a preset", async () => {
		const { qa, sessionPath } = await parkSessionAndHandOver("hpp-full", "full-access");
		const attacher = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(attacher);
		const attached = await openSession(attacher, { cwd: qa.cwd, sessionPath });
		const after = await probeTurn(attacher, attached.sessionId);
		expect(after.toolCallsMade).toBe(1);
		expect(after.prompts).toBe(0);
	}, 300_000);

	it("ask still asks when the client re-names ask on attach", async () => {
		const { qa, sessionPath } = await parkSessionAndHandOver("hpp-named", "ask");
		const attacher = await JsonlPeer.connect(qa.legacy);
		tracked.peers.push(attacher);
		const attached = await openSession(attacher, { cwd: qa.cwd, sessionPath, permissionPreset: "ask" });
		const after = await probeTurn(attacher, attached.sessionId);
		expect(after.toolCallsMade).toBe(1);
		expect(after.prompts).toBe(1);
	}, 300_000);
});
