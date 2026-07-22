/**
 * Compaction-route QA — OpenAI remote compaction with a MIXED-provider history.
 *
 * Drives the real CLI (`--mode rpc`) against a local mock that serves Anthropic
 * Messages SSE, OpenAI Responses SSE, and the OpenAI `/v1/responses/compact`
 * endpoint. The session first completes a turn on a mock ANTHROPIC model, then
 * switches to a mock OpenAI Responses model, compacts, and takes one more turn.
 *
 * Proves the capability-gated route end to end:
 *   1. compaction calls `/v1/responses/compact` even though the branch carries
 *      an anthropic assistant message (history provenance no longer gates),
 *   2. the compact request input replays that anthropic turn as a degraded
 *      assistant output_text item,
 *   3. the RPC `compact` response carries `senpi.compaction.openai-remote.v1`
 *      details,
 *   4. the next turn's `/v1/responses` payload replays the native compaction
 *      item (payload rewrite active after remote compaction).
 *
 * Usage: node compaction-remote-qa.mjs --self-test [--evidence SLUG]
 */

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	spawnCli,
} from "./lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv } from "./lib/mock-loop-support.mjs";

const CLAUDE_TEXT = `CLAUDE-TURN-7f3a ${"anthropic history that must degrade into an output_text item. ".repeat(6)}`;
const GPT_TEXT = `GPT-TURN-22b8 ${"openai native turn that stays in the branch. ".repeat(6)}`;
const AFTER_TEXT = "AFTER-COMPACTION-TURN-9c1d";

function sseHead(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
}

function writeAnthropicSse(res, text, modelId) {
	sseHead(res);
	const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	ev("message_start", {
		message: { id: "msg_mock", type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } },
	});
	ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 80 } });
	ev("message_stop", {});
	res.end();
}

function writeResponsesSse(res, text, modelId) {
	sseHead(res);
	let seq = 0;
	const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
	ev("response.created", { response: { id: "resp_mock", object: "response", status: "in_progress", model: modelId, output: [] } });
	ev("response.output_item.added", { output_index: 0, item: { id: "msg_mock", type: "message", status: "in_progress", role: "assistant", content: [] } });
	ev("response.content_part.added", { item_id: "msg_mock", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
	ev("response.output_text.delta", { item_id: "msg_mock", output_index: 0, content_index: 0, delta: text });
	const item = { id: "msg_mock", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
	ev("response.output_item.done", { output_index: 0, item });
	ev("response.completed", {
		response: { id: "resp_mock", object: "response", status: "completed", model: modelId, output: [item], usage: { input_tokens: 50, output_tokens: 80, total_tokens: 130 } },
	});
	res.end();
}

function startMockServer() {
	const requests = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body;
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {
				body = { unparseable: raw.slice(0, 200) };
			}
			const url = req.url ?? "";
			requests.push({ method: req.method, url, body });
			if (url.endsWith("/messages")) return writeAnthropicSse(res, CLAUDE_TEXT, body.model ?? "mock-claude");
			if (url.endsWith("/responses/compact")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "resp_compact_mock",
						created_at: 1_775_000_010,
						object: "response.compaction",
						output: [
							{ type: "message", id: "msg_retained", role: "user", content: [{ type: "input_text", text: "retained user context" }] },
							{ type: "compaction", id: "cmp_mock", encrypted_content: "encrypted-mock-summary" },
						],
						usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
					}),
				);
				return;
			}
			if (url.endsWith("/responses")) {
				const priorTurns = requests.filter((r) => r.url.endsWith("/responses")).length;
				return writeResponsesSse(res, priorTurns > 1 ? AFTER_TEXT : GPT_TEXT, body.model ?? "mock-gpt");
			}
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${url}` } }));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				requests,
				origin: `http://127.0.0.1:${port}`,
				stop: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

class RpcClient {
	constructor({ env, cwd }) {
		this.child = spawnCli(["--mode", "rpc", "--no-context-files"], { env, cwd });
		this.pending = new Map();
		this.events = [];
		this.seq = 0;
		this._buf = "";
		this.stderr = "";
		this.child.stdout.on("data", (chunk) => this._onData(chunk));
		this.child.stderr.on("data", (d) => {
			this.stderr += d.toString();
		});
	}

	_onData(chunk) {
		this._buf += chunk.toString();
		let nl;
		while ((nl = this._buf.indexOf("\n")) >= 0) {
			const line = this._buf.slice(0, nl).trim();
			this._buf = this._buf.slice(nl + 1);
			if (!line) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg && msg.type === "response") {
				const waiter = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
				if (waiter) {
					this.pending.delete(msg.id);
					waiter(msg);
				}
			} else if (msg && msg.type) {
				this.events.push(msg);
			}
		}
	}

	send(cmd, { timeoutMs = 90000 } = {}) {
		const id = cmd.id ?? `req-${++this.seq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC timeout ${cmd.type} (stderr: ${this.stderr.slice(-400)})`));
			}, timeoutMs);
			this.pending.set(id, (m) => {
				clearTimeout(timer);
				resolve(m);
			});
			this.child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	}

	async waitForEvent(pred, { timeoutMs = 90000 } = {}) {
		const start = Date.now();
		const from = this.events.length;
		for (;;) {
			const hit = this.events.slice(from).find(pred);
			if (hit) return hit;
			if (Date.now() - start > timeoutMs) throw new Error(`event wait timeout (stderr: ${this.stderr.slice(-400)})`);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	close() {
		try {
			this.child.stdin.end();
		} catch {}
	}
}

function writeSandboxConfig(agentDir, server) {
	const modelEntry = (api, id, baseUrl) => ({
		id,
		api,
		baseUrl,
		contextWindow: 128000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				anthropic: {
					baseUrl: server.origin,
					apiKey: "sk-ant-mock-7f3a",
					api: "anthropic-messages",
					models: [modelEntry("anthropic-messages", "mock-claude", server.origin)],
				},
				openai: {
					baseUrl: `${server.origin}/v1`,
					apiKey: "sk-openai-mock-7f3a",
					api: "openai-responses",
					models: [modelEntry("openai-responses", "mock-gpt", `${server.origin}/v1`)],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 40 } }));
}

async function selfTest(evidenceSlug) {
	installCleanupHooks();
	const checks = createChecks("compaction-remote-qa.mjs --self-test");
	const guard = guardRealAuth();
	const box = makeSandbox("compaction-remote-qa");
	const server = await startMockServer();
	writeSandboxConfig(box.agentDir, server);

	const client = new RpcClient({ env: hermeticEnv(box.env), cwd: box.cwd });
	let compactResponse;
	try {
		const prompt = async (message) => {
			const res = await client.send({ type: "prompt", message });
			if (res.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(res)}`);
		};
		await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });
		await prompt("Turn one: lay out the plan.");
		await client.waitForEvent((e) => e.type === "agent_end");

		await client.send({ type: "set_model", provider: "openai", modelId: "mock-gpt" });
		await prompt("Turn two: keep going.");
		await client.waitForEvent((e) => e.type === "agent_end", { timeoutMs: 90000 });

		compactResponse = await client.send({ type: "compact" });

		await prompt("Turn three: after compaction.");
		await client.waitForEvent((e) => e.type === "agent_end");
	} catch (error) {
		console.error("SCENARIO FAILURE DIAGNOSTICS");
		console.error("server urls:", JSON.stringify(server.requests.map((r) => `${r.method} ${r.url}`)));
		console.error("last events:", JSON.stringify(client.events.slice(-15).map((e) => e.type)));
		console.error("stderr tail:", client.stderr.slice(-1500));
		throw error;
	} finally {
		client.close();
	}

	const compactCalls = server.requests.filter((r) => r.url.endsWith("/responses/compact"));
	checks.ok(
		"remote compaction called /v1/responses/compact despite anthropic turn in history",
		compactCalls.length === 1,
		`compactCalls=${compactCalls.length}`,
	);

	const compactInput = compactCalls[0]?.body?.input ?? [];
	const degraded = compactInput.some(
		(item) => item?.type === "message" && item?.role === "assistant" && JSON.stringify(item).includes("CLAUDE-TURN-7f3a"),
	);
	checks.ok("anthropic turn degraded into an assistant output_text item in the compact input", degraded);

	const details = compactResponse?.data?.details;
	checks.ok(
		"RPC compact response carries senpi.compaction.openai-remote.v1 details",
		compactResponse?.success === true && details?.schema === "senpi.compaction.openai-remote.v1",
		`schema=${details?.schema ?? "none"}`,
	);

	const responsesCalls = server.requests.filter((r) => r.url.endsWith("/responses") && !r.url.endsWith("/responses/compact"));
	const postCompact = responsesCalls[responsesCalls.length - 1];
	const replayed = (postCompact?.body?.input ?? []).some((item) => item?.type === "compaction" && typeof item?.encrypted_content === "string");
	checks.ok(
		"post-compaction /v1/responses payload replays the native compaction item",
		responsesCalls.length >= 2 && replayed,
		`responsesCalls=${responsesCalls.length} replayed=${replayed}`,
	);

	const promptPreserved = (postCompact?.body?.input ?? []).some((item) =>
		JSON.stringify(item).includes("Turn three: after compaction."),
	);
	checks.ok("post-compaction /v1/responses payload still carries the user's new prompt", promptPreserved);

	checkRealAuthUnchanged(checks, guard);

	if (evidenceSlug) {
		const dir = evidenceDir(evidenceSlug);
		writeFileSync(
			join(dir, "compaction-remote-qa.json"),
			JSON.stringify(
				{
					compactCalls: compactCalls.map((c) => ({ url: c.url, body: c.body })),
					responsesCallCount: responsesCalls.length,
					responsesCalls: responsesCalls.map((c) => ({ url: c.url, body: c.body })),
					postCompactInput: postCompact?.body?.input ?? [],
					compactResponse: compactResponse ?? null,
				},
				null,
				2,
			),
		);
		writeFileSync(join(dir, "rpc-stderr.log"), client.stderr);
	}

	await server.stop();
	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

const evidenceSlug = process.argv.includes("--evidence") ? process.argv[process.argv.indexOf("--evidence") + 1] : undefined;
if (process.argv.includes("--self-test")) {
	selfTest(evidenceSlug).catch((error) => {
		console.error(error);
		process.exit(1);
	});
} else {
	console.log("usage: node compaction-remote-qa.mjs --self-test [--evidence SLUG]");
}
