/**
 * The host-handover leg of senpi#2465 over a REAL socket host (senpi#2842's preset was lost
 * across reload or session replacement; the fix reads the current runner/profile at swap time,
 * and the PR's in-process fixture has no socket host). Every case here opens a session on a
 * supervised host with a `permissionPreset`, then proves across (a) a generation handoff,
 * (b) session replacement (new/switch/fork) and (c) a reload that the next gated tool call
 * keeps the preset's behavior: full-access never prompts, ask still asks exactly once, a
 * settings deny survives, and an "Allow always" answer persists on disk and is not re-asked.
 *
 * The gated probe is the fixture extension's no-network `shell_fixture` tool, driven by a
 * scripted Anthropic-Messages server: first request -> one tool_use, follow-up -> "done".
 */

import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { approvedStorePath } from "../src/core/extensions/builtin/permission-system/storage.ts";
import { handoffHost } from "../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { JsonlPeer, MOCK_MODEL, openedSessionId, type WireRecord } from "./helpers/rpc-generation-support.ts";
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

const FIXTURE_EXTENSION = join(import.meta.dirname, "helpers", "rpc-permission-probe-extension.ts");
const PROBE_COMMAND = "echo probe-2465";

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
	for (const [event, data] of events) {
		res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	}
	res.end();
}

function messageStart(): readonly [string, Record<string, unknown>] {
	return [
		"message_start",
		{
			message: {
				id: "msg-probe-2465",
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
}

/**
 * True when the request's LAST message carries a tool result: a tool_result block, or, for a tool
 * the session does not offer (a settings deny hides it), the transcript's unavailable-tool-result
 * note. Only the latest message counts: a reopened session's history already holds earlier turns'
 * results, and keying on the whole body made every later turn answer "done" without calling the
 * tool, which read as "no prompt, tool ran" (the false alarm in senpi#3363).
 */
function latestMessageIsToolResult(raw: string): boolean {
	const messages = (JSON.parse(raw) as { messages?: Array<{ content?: unknown }> }).messages ?? [];
	const content = messages.at(-1)?.content;
	if (!Array.isArray(content)) return false;
	return content.some(
		(part: { type?: string; text?: string }) =>
			part.type === "tool_result" ||
			(part.type === "text" && part.text?.includes("<unavailable-tool-result") === true),
	);
}

/** Anthropic-Messages fake: one `shell_fixture` tool_use per turn, a plain "done" once that turn's result returns. */
async function startProbeModel(): Promise<{ origin: string }> {
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
			if (latestMessageIsToolResult(raw)) {
				writeSse(res, [
					messageStart(),
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
			writeSse(res, [
				messageStart(),
				[
					"content_block_start",
					{
						index: 0,
						content_block: { type: "tool_use", id: "toolu_probe_2465", name: "shell_fixture", input: {} },
					},
				],
				[
					"content_block_delta",
					{
						index: 0,
						delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: PROBE_COMMAND }) },
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
	return { origin: `http://127.0.0.1:${address.port}` };
}

interface ProbeResult {
	readonly prompts: number;
	readonly toolError: boolean | undefined;
	readonly toolText: string | undefined;
}

/** The live session's on-disk JSONL, via get_state: a verifiable record, not an in-memory projection. */
async function sessionFileOf(peer: JsonlPeer, sessionId: string): Promise<string> {
	const state = (await peer.request({ id: `sf-${probeCounter}`, type: "get_state", sessionId })) as WireRecord;
	const data = state.data as { sessionFile?: string } | undefined;
	if (typeof data?.sessionFile !== "string") throw new Error(`get_state had no sessionFile: ${JSON.stringify(state)}`);
	return data.sessionFile;
}

let probeCounter = 0;

async function probeTurn(peer: JsonlPeer, sessionId: string, answer?: string): Promise<ProbeResult> {
	probeCounter += 1;
	const text = `probe-${probeCounter}`;
	// `waitFor` replays seen records, and every probe on one session id ends with the same
	// agent_end shape: drop them so this probe settles on its own turn, not an earlier one.
	peer.messages.length = 0;
	const observed = peer.waitFor(
		(record) =>
			(record.type === "extension_ui_request" && record.method === "select") ||
			(record.type === "agent_end" && record.sessionId === sessionId),
		90_000,
	);
	await peer.request({ id: `prompt-${probeCounter}`, type: "prompt", sessionId, message: text });
	let prompts = 0;
	let record = await observed;
	while (record.type !== "agent_end") {
		prompts += 1;
		if (answer === undefined) throw new Error(`unexpected permission prompt: ${JSON.stringify(record)}`);
		// Drop the answered prompt before waiting again, or the replaying `waitFor` returns it forever.
		peer.messages.length = 0;
		// A multi-session host routes the answer by session; without it the host refuses it
		// (`missing_session_id`) and the prompt stays open.
		peer.send({ type: "extension_ui_response", id: String(record.id), sessionId, value: answer });
		record = await peer.waitFor(
			(next) =>
				(next.type === "extension_ui_request" && next.method === "select") ||
				(next.type === "agent_end" && next.sessionId === sessionId),
			90_000,
		);
	}
	const sessionFile = await sessionFileOf(peer, sessionId);
	const lines = (await readFile(sessionFile, "utf8")).trim().split("\n");
	const toolResult = lines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message as Record<string, unknown>)
		.findLast((message) => message?.role === "toolResult" && message?.toolName === "shell_fixture");
	if (toolResult === undefined) throw new Error("turn ended without a shell_fixture tool result");
	return {
		prompts,
		toolError: typeof toolResult.isError === "boolean" ? toolResult.isError : undefined,
		toolText: Array.isArray(toolResult?.content)
			? (toolResult.content as Array<Record<string, unknown>>)
					.filter((part) => part.type === "text")
					.map((part) => String(part.text))
					.join("\n")
			: undefined,
	};
}

async function openSession(
	peer: JsonlPeer,
	profile: Record<string, unknown>,
): Promise<{ sessionId: string; sessionPath: string }> {
	// docs/rpc.md (`session_path_in_use`): a path a previous generation still parks answers with
	// `owner.current: false` and `retry_after_ms`, and the open is a retry, not a failure. Retry only
	// that case, at the host's pace and within a bound; a current owner, or a claim that outlives the
	// bound, fails the test.
	const deadline = Date.now() + 60_000;
	let attempt = 0;
	let opened: WireRecord;
	for (;;) {
		attempt += 1;
		opened = await peer.request({
			id: `open-${probeCounter}-${peer.messages.length}-${attempt}`,
			type: "open_session",
			...profile,
		});
		const data = opened.errorData as { owner?: { current?: boolean }; retry_after_ms?: number } | undefined;
		const parkingPredecessor =
			opened.success !== true &&
			opened.errorCode === "session_path_in_use" &&
			data?.owner?.current === false &&
			typeof data.retry_after_ms === "number";
		if (!parkingPredecessor || Date.now() + (data?.retry_after_ms ?? 0) > deadline) break;
		await new Promise((resolve) => setTimeout(resolve, data?.retry_after_ms));
	}
	if (opened.success !== true) throw new Error(`open_session failed: ${JSON.stringify(opened)}`);
	const data = opened.data as { sessionPath?: string; state?: { sessionFile?: string } };
	const sessionPath = data.sessionPath ?? data.state?.sessionFile;
	if (typeof sessionPath !== "string") throw new Error(`open_session had no session path: ${JSON.stringify(opened)}`);
	return { sessionId: openedSessionId(opened), sessionPath };
}

async function handover(qa: EndpointScratch): Promise<string> {
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
	return result.instanceId;
}

describe.skipIf(process.platform === "win32")(
	"senpi#2465 host-handover permission legs over a real socket host",
	() => {
		it("full-access stays full across a handover, session replacement, and a reload", async () => {
			const model = await startProbeModel();
			const qa = endpointScratch("hfa", model.origin);
			await realHost(qa, qa.legacy, { extension: FIXTURE_EXTENSION });
			const peer = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(peer);
			const opened = await openSession(peer, { cwd: qa.cwd, permissionPreset: "full-access" });

			// (0) baseline: a gated call on the fresh full-access session never asks
			const initial = await probeTurn(peer, opened.sessionId);
			expect(initial.prompts).toBe(0);
			expect(initial.toolError).toBe(false);
			peer.messages.length = 0;

			// A second persisted full-access session, seeded with one turn, as the switch target
			const seeded = await openSession(peer, { cwd: qa.cwd, permissionPreset: "full-access" });
			expect((await probeTurn(peer, seeded.sessionId)).prompts).toBe(0);
			peer.messages.length = 0;

			// (a) a host handover: the parked session re-opened on the new generation stays full
			const parked = peer.waitFor(
				(record) => record.type === "session_closed" && record.reason === "handoff_parked",
				60_000,
			);
			await handover(qa);
			const parkedRecord = await parked;
			await peer.waitForClose();
			const afterHandoff = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(afterHandoff);
			const resumed = await openSession(afterHandoff, {
				cwd: qa.cwd,
				permissionPreset: "full-access",
				sessionPath: String((parkedRecord as WireRecord).sessionPath),
			});
			const afterHandoverProbe = await probeTurn(afterHandoff, resumed.sessionId);
			expect(afterHandoverProbe.prompts).toBe(0);
			expect(afterHandoverProbe.toolError).toBe(false);

			// (b) session replacement: /new, a switch into a second seeded file, and a fork of it
			await afterHandoff.request({ id: "new", type: "new_session", sessionId: resumed.sessionId });
			const afterNew = await probeTurn(afterHandoff, resumed.sessionId);
			expect(afterNew.prompts).toBe(0);
			expect(afterNew.toolError).toBe(false);
			peer.messages.length = 0;
			afterHandoff.messages.length = 0;

			await afterHandoff.request({
				id: "switch",
				type: "switch_session",
				sessionId: resumed.sessionId,
				sessionPath: seeded.sessionPath,
			});
			const afterSwitch = await probeTurn(afterHandoff, resumed.sessionId);
			expect(afterSwitch.prompts).toBe(0);
			expect(afterSwitch.toolError).toBe(false);

			const forkables = (await afterHandoff.request({
				id: "forkables",
				type: "get_fork_messages",
				sessionId: resumed.sessionId,
			})) as WireRecord;
			const forkData = forkables.data as { messages?: Array<{ entryId: string }> } | undefined;
			const forkTarget = forkData?.messages?.at(-1);
			if (!forkTarget) throw new Error("no forkable user message after the switch probe");
			await afterHandoff.request({
				id: "fork",
				type: "fork",
				sessionId: resumed.sessionId,
				entryId: forkTarget.entryId,
			});
			const afterFork = await probeTurn(afterHandoff, resumed.sessionId);
			expect(afterFork.prompts).toBe(0);
			expect(afterFork.toolError).toBe(false);

			// (c) a reload keeps the preset
			await afterHandoff.request({ id: "reload", type: "reload", sessionId: resumed.sessionId });
			const afterReload = await probeTurn(afterHandoff, resumed.sessionId);
			expect(afterReload.prompts).toBe(0);
			expect(afterReload.toolError).toBe(false);
		}, 300_000);

		it("ask still asks exactly once after a handover, each replacement, and a reload", async () => {
			const model = await startProbeModel();
			const qa = endpointScratch("has", model.origin);
			await realHost(qa, qa.legacy, { extension: FIXTURE_EXTENSION });
			const peer = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(peer);
			const opened = await openSession(peer, { cwd: qa.cwd, permissionPreset: "ask" });

			const initial = await probeTurn(peer, opened.sessionId, "Allow once");
			expect(initial.prompts).toBe(1);
			expect(initial.toolError).toBe(false);
			peer.messages.length = 0;

			const seeded = await openSession(peer, { cwd: qa.cwd, permissionPreset: "ask" });
			expect((await probeTurn(peer, seeded.sessionId, "Allow once")).prompts).toBe(1);
			peer.messages.length = 0;

			const parked = peer.waitFor(
				(record) => record.type === "session_closed" && record.reason === "handoff_parked",
				60_000,
			);
			await handover(qa);
			const parkedRecord = await parked;
			await peer.waitForClose();
			const afterHandoff = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(afterHandoff);
			const resumed = await openSession(afterHandoff, {
				cwd: qa.cwd,
				permissionPreset: "ask",
				sessionPath: String((parkedRecord as WireRecord).sessionPath),
			});
			const afterHandoverProbe = await probeTurn(afterHandoff, resumed.sessionId, "Allow once");
			expect(afterHandoverProbe.prompts).toBe(1);
			expect(afterHandoverProbe.toolError).toBe(false);
			afterHandoff.messages.length = 0;

			await afterHandoff.request({ id: "new", type: "new_session", sessionId: resumed.sessionId });
			expect((await probeTurn(afterHandoff, resumed.sessionId, "Allow once")).prompts).toBe(1);
			afterHandoff.messages.length = 0;

			await afterHandoff.request({
				id: "switch",
				type: "switch_session",
				sessionId: resumed.sessionId,
				sessionPath: seeded.sessionPath,
			});
			expect((await probeTurn(afterHandoff, resumed.sessionId, "Allow once")).prompts).toBe(1);
			afterHandoff.messages.length = 0;

			const forkables = (await afterHandoff.request({
				id: "forkables",
				type: "get_fork_messages",
				sessionId: resumed.sessionId,
			})) as WireRecord;
			const forkData = forkables.data as { messages?: Array<{ entryId: string }> } | undefined;
			const forkTarget = forkData?.messages?.at(-1);
			if (!forkTarget) throw new Error("no forkable user message after the switch probe");
			await afterHandoff.request({
				id: "fork",
				type: "fork",
				sessionId: resumed.sessionId,
				entryId: forkTarget.entryId,
			});
			expect((await probeTurn(afterHandoff, resumed.sessionId, "Allow once")).prompts).toBe(1);

			await afterHandoff.request({ id: "reload", type: "reload", sessionId: resumed.sessionId });
			expect((await probeTurn(afterHandoff, resumed.sessionId, "Allow once")).prompts).toBe(1);
		}, 300_000);

		it("a settings deny survives a handover under full-access", async () => {
			const model = await startProbeModel();
			const qa = endpointScratch("hdeny", model.origin);
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(join(qa.cwd, CONFIG_DIR_NAME), { recursive: true });
			await writeFile(
				join(qa.cwd, CONFIG_DIR_NAME, "settings.json"),
				`${JSON.stringify({ permission: { shell_fixture: "deny" } }, null, 2)}\n`,
			);
			await realHost(qa, qa.legacy, { extension: FIXTURE_EXTENSION });
			const peer = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(peer);
			const opened = await openSession(peer, { cwd: qa.cwd, permissionPreset: "full-access" });

			const denied = await probeTurn(peer, opened.sessionId);
			expect(denied.prompts).toBe(0);
			expect(denied.toolError).toBe(true);
			expect(denied.toolText).toContain("shell_fixture");
			peer.messages.length = 0;

			const parked = peer.waitFor(
				(record) => record.type === "session_closed" && record.reason === "handoff_parked",
				60_000,
			);
			await handover(qa);
			const parkedRecord = await parked;
			await peer.waitForClose();
			const afterHandoff = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(afterHandoff);
			const resumed = await openSession(afterHandoff, {
				cwd: qa.cwd,
				permissionPreset: "full-access",
				sessionPath: String((parkedRecord as WireRecord).sessionPath),
			});
			const stillDenied = await probeTurn(afterHandoff, resumed.sessionId);
			expect(stillDenied.prompts).toBe(0);
			expect(stillDenied.toolError).toBe(true);
		}, 300_000);

		it("an Always answer is on disk and is not re-asked after a handover", async () => {
			const model = await startProbeModel();
			const qa = endpointScratch("halways", model.origin);
			await realHost(qa, qa.legacy, { extension: FIXTURE_EXTENSION });
			const peer = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(peer);
			const opened = await openSession(peer, { cwd: qa.cwd, permissionPreset: "ask" });

			const first = await probeTurn(peer, opened.sessionId, "Allow always");
			expect(first.prompts).toBe(1);
			expect(first.toolError).toBe(false);
			peer.messages.length = 0;

			// Approvals live in the agent-dir store, outside the project the agent can write (senpi#2465).
			const approvedFile = approvedStorePath(qa.agentDir, qa.cwd);
			const stored = await readFile(approvedFile, "utf8");
			expect(stored).toContain('"shell_fixture"');

			const parked = peer.waitFor(
				(record) => record.type === "session_closed" && record.reason === "handoff_parked",
				60_000,
			);
			await handover(qa);
			const parkedRecord = await parked;
			await peer.waitForClose();
			const afterHandoff = await JsonlPeer.connect(qa.legacy);
			tracked.peers.push(afterHandoff);
			const resumed = await openSession(afterHandoff, {
				cwd: qa.cwd,
				permissionPreset: "ask",
				sessionPath: String((parkedRecord as WireRecord).sessionPath),
			});
			const afterHandoverProbe = await probeTurn(afterHandoff, resumed.sessionId);
			expect(afterHandoverProbe.prompts).toBe(0);
			expect(afterHandoverProbe.toolError).toBe(false);

			const storedAfter = await readFile(approvedFile, "utf8");
			expect(storedAfter.trim().split("\n").length).toBe(1);
		}, 300_000);
	},
);
