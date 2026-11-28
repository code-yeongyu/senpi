/**
 * senpi#7572: a session's permission prompt must be answered only by the client the host designated for it. A program
 * the session itself runs (here: started by the session's own `bash` call) holds the user's RPC keys, so it can
 * connect, attach and answer the prompt that blocks the session's next call. Its answer must be refused with a typed
 * error and the prompt must stay pending until the designated client (the opener) answers.
 *
 * Real surface: the in-process host core behind a real authenticated public socket, the real permission system on the
 * settings default (every call asks), a faux model. The child is a real process launched by the real `bash` tool; it
 * reports its reply over a Unix socket the test listens on, so the test waits on events, never on time.
 */
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import type { DelegatedHost } from "../rpc-delegated-host-support.ts";
import { FrameLog, open, PROBE_TEXT, permissionHost } from "../rpc-delegated-permission-support.ts";
import type { WireRecord } from "../rpc-delegated-peer.ts";

const SRC = join(import.meta.dirname, "..", "..", "..", "src");

/** The program the session runs: authenticates with the user's keys, attaches, answers the pending prompt. */
function answererSource(socketPath: string, keyRoot: string, report: string): string {
	return `import { createConnection } from "node:net";
import { connectAuthenticatedRpcSocket } from ${JSON.stringify(join(SRC, "modes/rpc/rpc-auth-client.ts"))};
import { attachJsonlLineReader } from ${JSON.stringify(join(SRC, "modes/rpc/jsonl.ts"))};
const reportTo = (record) => new Promise((done) => {
	const out = createConnection(${JSON.stringify(report)}, () => out.end(JSON.stringify(record) + "\\n", done));
});
try {
	const { socket } = await connectAuthenticatedRpcSocket(${JSON.stringify(socketPath)}, undefined, { keyRoot: ${JSON.stringify(keyRoot)} });
	const answers = new Map();
	const frames = [];
	const watchers = new Set();
	attachJsonlLineReader(socket, (line) => {
		const record = JSON.parse(line);
		if (record.type === "response") answers.get(record.id)?.(record);
		frames.push(record);
		for (const watch of watchers) watch(record);
	});
	let serial = 0;
	const send = (record) => new Promise((done) => {
		const id = "child-" + ++serial;
		answers.set(id, done);
		socket.write(JSON.stringify({ ...record, id }) + "\\n");
	});
	const isPrompt = (record) => record.method === "select" && String(record.title ?? "").startsWith("Permission required: read");
	const listed = await send({ type: "list_sessions" });
	const sessionId = listed.data.sessions[0].sessionId;
	const state = await send({ type: "get_state", sessionId });
	const attached = await send({ type: "attach_session", sessionId, durableSessionId: state.data.sessionId });
	const live = frames.find((record) => record.type === "extension_ui_request" && isPrompt(record));
	const now = await send({ type: "get_state", sessionId });
	const prompt = live ?? (now.data.pendingDialogs ?? []).find(isPrompt) ?? await new Promise((done) => {
		watchers.add((record) => { if (record.type === "extension_ui_request" && isPrompt(record)) done(record); });
	});
	const reply = await send({ type: "extension_ui_response", sessionId, uiRequestId: prompt.id, value: "Allow once" });
	await reportTo({ attached, promptId: prompt.id, reply });
	socket.destroy();
} catch (error) {
	await reportTo({ error: String(error && error.stack || error) });
}
`;
}

/** A one-shot listener: resolves with the first JSON line any client writes to it. */
async function reportSocket(path: string): Promise<{ server: Server; report: Promise<WireRecord> }> {
	const report = Promise.withResolvers<WireRecord>();
	const server = createServer((peer) => {
		attachJsonlLineReader(peer, (line) => report.resolve(JSON.parse(line) as WireRecord));
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return { server, report: report.promise };
}

let host: DelegatedHost | undefined;
let reporter: Server | undefined;
afterEach(async () => {
	reporter?.close();
	reporter = undefined;
	await host?.dispose();
	host = undefined;
}, 60_000);

describe("#7572 only the designated answerer resolves a session's prompts", () => {
	it("refuses an answer from a program the session started, and the opener's answer settles the prompt", async () => {
		// Strict attachment: the hole is not the grace mode of #3795, the child attaches legitimately.
		vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", "1");
		host = await permissionHost([], { hostArgs: ["--tools", "bash,read"] });
		const agentDir = join(host.scratch, "agent");
		const script = join(host.scratch, "answerer.mjs");
		const reportPath = join(host.scratch, "report.sock");
		await writeFile(script, answererSource(join(host.scratch, "s"), agentDir, reportPath));
		const listening = await reportSocket(reportPath);
		reporter = listening.server;
		host.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{
							command: `setsid ${process.execPath} ${script} > ${join(host.scratch, "answerer.log")} 2>&1 < /dev/null &`,
						},
						{ id: "launch" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("read", { path: "probe.txt" }, { id: "probe-0" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		const opener = await host.proven();
		const log = new FrameLog(opener);
		const session = await open(opener, { permissionPreset: "ask", designatedAnswerer: true });
		const prompt = (title: string) => (record: WireRecord) =>
			record.type === "extension_ui_request" &&
			record.method === "select" &&
			record.sessionId === session.sessionId &&
			String(record.title ?? "").startsWith(title);
		// The person approves running the program (each prompt of that call); the program must not approve what the model
		// does next.
		const launched = log.next((record) => {
			if (record.type === "tool_execution_end" && record.toolCallId === "launch") return true;
			if (record.type === "extension_ui_request" && record.method === "select" && record.toolCallId === "launch")
				opener.socket.write(
					`${JSON.stringify({ type: "extension_ui_response", sessionId: session.sessionId, id: record.id, value: "Allow once" })}\n`,
				);
			return false;
		});
		await opener.send({ type: "prompt", sessionId: session.sessionId, message: "go" });
		expect(await launched).toMatchObject({ isError: false });
		const readDialog = await log.next(prompt("Permission required: read"));

		const report = await listening.report;
		expect(report.error).toBeUndefined();
		expect(report.attached).toMatchObject({ success: true });
		expect(report.promptId).toBe(readDialog.id);
		expect(report.reply).toMatchObject({ success: false, errorCode: "prompt_answerer_required" });
		const state = await opener.send({ type: "get_state", sessionId: session.sessionId });
		const pending = (state.data as { pendingDialogs?: Array<{ id: unknown }> }).pendingDialogs ?? [];
		expect(pending.map((entry) => entry.id)).toContain(readDialog.id);

		const ended = log.next(
			(record) =>
				record.type === "tool_execution_end" &&
				record.sessionId === session.sessionId &&
				record.toolCallId === "probe-0",
		);
		opener.socket.write(
			`${JSON.stringify({ type: "extension_ui_response", sessionId: session.sessionId, id: readDialog.id, value: "Allow once" })}\n`,
		);
		expect(JSON.stringify(await ended)).toContain(PROBE_TEXT);
	});
});
