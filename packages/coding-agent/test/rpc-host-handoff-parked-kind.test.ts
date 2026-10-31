/**
 * A client-less retained WORKER session keeps its visibility class and context when the SUCCESSOR host
 * reopens it from the handover-parked record (senpi#3368, invariant I4): a default list_sessions omits
 * it, and include_workers lists it with its kind and its context labels.
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
// oxlint-disable-next-line jest/no-duplicate-hooks -- a second top-level hook kept separate; merging them would change the hook order
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

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

async function listRows(qa: EndpointScratch, includeWorkers: boolean) {
	const lister = await JsonlPeer.connect(qa.legacy);
	try {
		const listed = (await lister.request({
			id: nextId("list"),
			type: "list_sessions",
			...(includeWorkers ? { include_workers: true } : {}),
		})) as WireRecord;
		return (listed.data as { sessions?: Array<Record<string, unknown>> })?.sessions ?? [];
	} finally {
		lister.destroy();
	}
}

async function waitForWorkerReopen(qa: EndpointScratch, sessionPath: string): Promise<void> {
	const canonical = canonicalPath(sessionPath);
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const rows = await listRows(qa, true);
		if (
			rows.some(
				(row) =>
					typeof row.sessionPath === "string" &&
					canonicalPath(row.sessionPath) === canonical &&
					row.status === "open",
			)
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`the successor never reopened ${sessionPath}`);
}

describe.skipIf(process.platform === "win32")(
	"a parked worker session reopened by the successor keeps its kind (I4)",
	() => {
		it("stays out of a default list_sessions and keeps its kind and context", async () => {
			const origin = await startProbeModel();
			const qa = endpointScratch("hpk-worker", origin);
			await realHost(qa, qa.legacy, { extension: FIXTURE_EXTENSION });
			const opener = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(opener);
			const opened = await openSession(opener, {
				cwd: qa.cwd,
				permissionPreset: "full-access",
				retain_on_disconnect: true,
				kind: "worker",
				context: { lane: "senpi-3368" },
			});
			expect((await probeTurn(opener, opened.sessionId)).toolCallsMade).toBe(1);
			const canonical = canonicalPath(opened.sessionPath);
			const isOurs = (row: Record<string, unknown>) =>
				typeof row.sessionPath === "string" && canonicalPath(row.sessionPath) === canonical;
			expect((await listRows(qa, false)).some(isOurs)).toBe(false);
			opener.destroy();

			await handover(qa);
			await waitForWorkerReopen(qa, opened.sessionPath);

			expect((await listRows(qa, false)).some(isOurs), "a reopened worker session became visible by default").toBe(
				false,
			);
			const listed = (await listRows(qa, true)).find(isOurs);
			expect(listed?.kind).toBe("worker");
			expect(listed?.context).toMatchObject({ lane: "senpi-3368" });
		}, 300_000);
	},
);
