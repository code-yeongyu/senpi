#!/usr/bin/env node
/**
 * Real-CLI QA for builtin compaction's shared transient-summary retry.
 *
 * Two normal turns create a real compactable session, then the RPC `compact`
 * command enters the builtin extension's core-route summarization hook. The
 * local Anthropic server identifies the private summary request by
 * its trailing internal-compaction user message, fails attempt one with the
 * original Worker OOM body, and succeeds on the retry.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/compaction-shared-retry-qa.mjs \
 *     --evidence 20260812-compaction-shared-retry
 */

import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	spawnCli,
} from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";

const CONTEXT_WINDOW = 10_000;
const PINNED_INPUT_TOKENS = 9_950;
const SUMMARY_MARKERS = [
	"[INTERNAL COMPACTION INSTRUCTION",
	"[INTERNAL COMPACTION UPDATE INSTRUCTION",
	"[INTERNAL TURN-PREFIX SUMMARY INSTRUCTION",
	"[INTERNAL BRANCH SUMMARY INSTRUCTION",
];
const WORKER_OOM_TEXT = "Worker exceeded memory limit.";
const WORKER_OOM_BODY = JSON.stringify({
	type: "error",
	error: { type: "api_error", message: WORKER_OOM_TEXT },
});

function flag(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "text" ? String(part.text ?? "") : "")).join("\n");
}

function classifyRequest(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const trailing = messages.at(-1);
	const trailingText = trailing?.role === "user" ? textOfContent(trailing.content) : "";
	return {
		summarization: SUMMARY_MARKERS.some((marker) => trailingText.includes(marker)),
		trailingPrefix: trailingText.slice(0, 100).replaceAll("\n", "\\n"),
	};
}

function writeAnthropicSse(res, text, modelId, inputTokens) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const event = (type, data) =>
		res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event("message_start", {
		message: {
			id: `msg_mock_${Date.now()}`,
			type: "message",
			role: "assistant",
			model: modelId,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: inputTokens, output_tokens: 0 },
		},
	});
	event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	event("content_block_stop", { index: 0 });
	event("message_delta", {
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: Math.max(1, Math.ceil(text.length / 4)) },
	});
	event("message_stop", {});
	res.end();
}

function startScriptedServer() {
	const requests = [];
	let summarizationAttempt = 0;
	let normalTurn = 0;
	const sockets = new Set();
	const historyText = (turn, lines) =>
		Array.from(
			{ length: lines },
			(_, index) =>
				`turn-${turn}-record-${String(index).padStart(4, "0")}: preserve artifact-${turn}-${index * 17 + 3} with decision-${index * 29 + 7}.`,
		).join("\n");
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const at = Date.now();
			const raw = Buffer.concat(chunks).toString("utf8");
			let body = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {}
			const shape = classifyRequest(body);
			const record = {
				at,
				method: req.method,
				url: req.url,
				summarization: shape.summarization,
				trailingPrefix: shape.trailingPrefix,
				response: "",
			};
			requests.push(record);

			if (shape.summarization) {
				summarizationAttempt++;
				if (summarizationAttempt === 1) {
					record.response = `500 ${WORKER_OOM_BODY}`;
					res.writeHead(500, { "content-type": "application/json" });
					res.end(WORKER_OOM_BODY);
					return;
				}
				record.response = "200 recovered compaction summary";
				writeAnthropicSse(
					res,
					`<task-intent>\nORIGINAL_REQUEST: Continue the QA scenario.\nTASK_TYPE: QA\nMUST_PRESERVE: transient retry evidence\nMUST_NOT_LOSE: Worker OOM first attempt\n</task-intent>\n<summary>\n## 1. User Requests (Verbatim)\n- Continue the QA scenario.\n## 2. Final Goal\nProve compaction retry.\n## 3. Constraints & Preferences (Verbatim Only)\nNone.\n## 4. Work Completed\nRecovered after a transient summary failure.\n## 5. Active Working Context\nReal RPC CLI and local Anthropic server.\n## 6. Remaining Tasks\nNone.\n## 7. Exact Next Steps\nContinue the admitted turn.\n</summary>`,
					body.model ?? "mock-claude",
					500,
				);
				return;
			}

			normalTurn++;
			record.response = `200 normal turn ${normalTurn}`;
			const text = normalTurn <= 2 ? historyText(normalTurn, normalTurn === 1 ? 80 : 120) : `QA-TURN-${normalTurn}-OK`;
			writeAnthropicSse(
				res,
				text,
				body.model ?? "mock-claude",
				normalTurn === 2 ? PINNED_INPUT_TOKENS : 200,
			);
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				requests,
				origin: `http://127.0.0.1:${address.port}`,
				port: address.port,
				async stop() {
					for (const socket of sockets) socket.destroy();
					if (server.listening) await new Promise((done) => server.close(done));
				},
				isListening: () => server.listening,
			});
		});
	});
}

function writeSandboxConfig(agentDir, server) {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					anthropic: {
						baseUrl: server.origin,
						apiKey: "sk-ant-mock-compaction-retry-qa",
						api: "anthropic-messages",
						models: [
							{
								id: "mock-claude",
								api: "anthropic-messages",
								baseUrl: server.origin,
								contextWindow: CONTEXT_WINDOW,
								maxTokens: 1_000,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				compaction: {
					enabled: true,
					reserveTokens: 100,
					keepRecentTokens: 1_024,
					speculativeEnabled: false,
					idleCompactionEnabled: false,
				},
			},
			null,
			2,
		),
	);
}

class RpcClient {
	constructor({ env, cwd }) {
		this.child = spawnCli(["--mode", "rpc", "--no-context-files"], { env, cwd });
		this.pending = new Map();
		this.events = [];
		this.seq = 0;
		this.buffer = "";
		this.stderr = "";
		this.child.stdout.on("data", (chunk) => this.onData(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
	}

	onData(chunk) {
		this.buffer += chunk.toString();
		let newline;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (message?.type === "response" && message.id !== undefined && this.pending.has(message.id)) {
				this.pending.get(message.id)(message);
				this.pending.delete(message.id);
			} else if (message?.type) {
				this.events.push({ at: Date.now(), msg: message });
			}
		}
	}

	send(command, { timeoutMs = 30_000 } = {}) {
		const id = command.id ?? `qa-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout for ${command.type}; stderr=${this.stderr.slice(-500)}`));
			}, timeoutMs);
			this.pending.set(id, (response) => {
				clearTimeout(timer);
				if (response.success === false) {
					reject(new Error(`RPC ${command.type} failed: ${response.error}`));
					return;
				}
				resolve(response);
			});
			this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		});
	}

	async waitForEvent(predicate, afterIndex, timeoutMs = 30_000) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.slice(afterIndex).find((entry) => predicate(entry.msg));
			if (found) return found.msg;
			if (Date.now() >= deadline) {
				throw new Error(`event timeout; stderr=${this.stderr.slice(-500)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async close() {
		if (this.child.exitCode !== null) return;
		try {
			this.child.stdin.end();
		} catch {}
		const closed = once(this.child, "close");
		const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_000));
		if ((await Promise.race([closed, timeout])) === "timeout" && this.child.exitCode === null) {
			this.child.kill("SIGKILL");
			await once(this.child, "close");
		}
	}
}

async function runPrompt(client, message, timeoutMs = 30_000) {
	const afterIndex = client.events.length;
	const response = await client.send({ type: "prompt", message }, { timeoutMs });
	const terminal = await client.waitForEvent(
		(event) => event.type === "agent_settled" || event.type === "agent_aborted",
		afterIndex,
		timeoutMs,
	);
	return { response, terminal };
}

function eventDetail(message) {
	if (message.type === "compaction_start") {
		return ` reason=${message.reason ?? message.data?.reason ?? "unknown"} requestId=${message.requestId ?? "none"}`;
	}
	if (message.type === "compaction_end") {
		return ` reason=${message.reason ?? message.data?.reason ?? "unknown"} accepted=${message.accepted ?? message.data?.accepted ?? Boolean(message.result)} aborted=${message.aborted ?? false} error=${JSON.stringify(message.errorMessage ?? message.data?.errorMessage ?? null)}`;
	}
	return "";
}

async function main() {
	installCleanupHooks();
	const command =
		"node .agents/skills/senpi-qa/scripts/scenarios/compaction-shared-retry-qa.mjs --evidence 20260812-compaction-shared-retry";
	const evidenceName = flag("--evidence", "20260812-compaction-shared-retry");
	const evidence = evidenceDir(evidenceName.replace(/^\d{8}-/, ""));
	const evidencePath = join(evidence, "real-cli-timeline.txt");
	const checks = createChecks("compaction-shared-retry-qa.mjs");
	const passLines = [];
	const check = (name, condition, detail) => {
		checks.ok(name, condition, detail);
		passLines.push(`[${condition ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
	};
	const guard = guardRealAuth();
	const box = makeSandbox("senpi-qa-compaction-shared-retry");
	const startedAt = Date.now();
	let server;
	let client;
	let cleanupReceipt = "cleanup pending";
	let runError;

	try {
		server = await startScriptedServer();
		writeSandboxConfig(box.agentDir, server);
		client = new RpcClient({ env: hermeticEnv(box.env), cwd: box.cwd });
		await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });

		const seedOne = await runPrompt(client, "Seed the oldest QA context and preserve its decisions.");
		if (seedOne.terminal.type !== "agent_settled") throw new Error(`seed one ended as ${seedOne.terminal.type}`);
		const seedTwo = await runPrompt(client, "Add the latest QA context while retaining the earlier turn.");
		if (seedTwo.terminal.type !== "agent_settled") throw new Error(`seed two ended as ${seedTwo.terminal.type}`);

		// The real RPC compact command routes through session_before_compact. The
		// builtin extension handles that hook with snapshot origin `core-route`,
		// which is one of the two origins eligible for the shared retry.
		await client.send({ type: "compact" }, { timeoutMs: 45_000 });
	} catch (error) {
		runError = error;
	} finally {
		await client?.close().catch(() => {});
		await server?.stop().catch(() => {});
		box.cleanup();
		cleanupReceipt = `cliExited=${client ? client.child.exitCode !== null : true} serverListening=${server?.isListening() ?? false} sandboxExists=${existsSync(box.dir)}`;
	}

	const requests = server?.requests ?? [];
	const summaryRequests = requests.filter((request) => request.summarization);
	const compactionEnds = (client?.events ?? []).filter((entry) => entry.msg.type === "compaction_end");
	const acceptedEnds = compactionEnds.filter(
		(entry) => (entry.msg.accepted ?? entry.msg.data?.accepted ?? Boolean(entry.msg.result)) === true,
	);
	const terminalOomEnds = compactionEnds.filter((entry) =>
		String(entry.msg.errorMessage ?? entry.msg.data?.errorMessage ?? "").includes(WORKER_OOM_TEXT),
	);

	check(
		"first summarization attempt received the verbatim Worker OOM body",
		summaryRequests[0]?.response === `500 ${WORKER_OOM_BODY}`,
		summaryRequests[0]?.response ?? "no summarization request",
	);
	check(
		"core-route extension compaction retried summarization",
		summaryRequests.length > 1,
		`summarizationRequests=${summaryRequests.length}`,
	);
	check(
		"a compaction was accepted",
		acceptedEnds.length > 0,
		`acceptedCompactionEnds=${acceptedEnds.length}`,
	);
	check(
		"no terminal compaction_end carried the Worker OOM text",
		terminalOomEnds.length === 0,
		`terminalOomCompactionEnds=${terminalOomEnds.length}`,
	);

	let authUnchanged = false;
	try {
		authUnchanged = guard.assertUnchanged();
	} catch {}
	check("real auth unchanged", authUnchanged, guard.path);
	check(
		"spawned resources were cleaned up",
		cleanupReceipt === "cliExited=true serverListening=false sandboxExists=false",
		cleanupReceipt,
	);

	const relative = (at) => `${((at - startedAt) / 1_000).toFixed(3)}s`;
	const lines = [
		`command: ${command}`,
		`fakeProvider: ${server?.origin ?? "not-started"}`,
		`contextWindow=${CONTEXT_WINDOW} pinnedInputTokens=${PINNED_INPUT_TOKENS}`,
		`runError=${runError instanceof Error ? runError.stack : (runError ?? "none")}`,
		"",
		"REQUEST TIMELINE",
		...requests.map(
			(request, index) =>
				`${relative(request.at)} request#${index + 1} ${request.summarization ? "SUMMARIZATION" : "NORMAL"} ${request.method} ${request.url} trailing=${JSON.stringify(request.trailingPrefix)} response=${request.response}`,
		),
		"",
		"EVENT TIMELINE",
		...(client?.events ?? [])
			.filter((entry) => !["message_update", "message_start"].includes(entry.msg.type))
			.map((entry) => `${relative(entry.at)} ${entry.msg.type}${eventDetail(entry.msg)}`),
		"",
		`summary: summarizationRequests=${summaryRequests.length} acceptedCompactionEnds=${acceptedEnds.length} terminalOomCompactionEnds=${terminalOomEnds.length}`,
		...passLines,
		`cleanup: ${cleanupReceipt}`,
		"",
	];
	writeFileSync(evidencePath, `${lines.join("\n")}\n`);
	process.stdout.write(`evidence: ${evidencePath}\n`);
	if (runError) process.stderr.write(`${runError instanceof Error ? runError.stack : String(runError)}\n`);
	process.exit(checks.finish() && !runError ? 0 : 1);
}

await main();
