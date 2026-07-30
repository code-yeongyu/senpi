#!/usr/bin/env node
/**
 * Repro driver: persistent provider failure + over-threshold context.
 *
 * Turn 1 succeeds with huge usage (context pinned near the hard limit).
 * Every later request (turns AND compaction summarization) fails with a
 * transient "Connection error." — the same shape as a real provider outage.
 *
 * Observation targets:
 *   - whether compaction_start/compaction_end cycle forever without the agent
 *     ever settling (infinite retry<->compaction cycle), and
 *   - whether the final state leaves a compaction_start with no matching end
 *     (lifecycle leak = the "Compacting..." spinner that never closes).
 *
 * Usage: node compaction-retry-cycle-repro.mjs [--watch-ms 240000]
 */

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, guardRealAuth, installCleanupHooks, makeSandbox, spawnCli } from "../lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv } from "../lib/mock-loop-support.mjs";

const CONTEXT_WINDOW = 128_000;
const PINNED_INPUT_TOKENS = 120_000;
const SUMMARY_MARKER = "context summarization assistant";

function sseHead(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
}

function writeAnthropicSse(res, text, modelId, inputTokens) {
	sseHead(res);
	const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	ev("message_start", {
		message: {
			id: "msg_mock",
			type: "message",
			role: "assistant",
			model: modelId,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: inputTokens, output_tokens: 0 },
		},
	});
	ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
	ev("content_block_stop", { index: 0 });
	ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
	ev("message_stop", {});
	res.end();
}

function startFlappingServer() {
	const requests = [];
	let callIndex = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {}
			const systemText = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
			const isSummarization = systemText.includes(SUMMARY_MARKER);
			requests.push({ at: Date.now(), url: req.url, summarization: isSummarization, systemPrefix: systemText.slice(0, 60) });
			callIndex++;
			if (callIndex === 1) {
				return writeAnthropicSse(res, "x".repeat(400_000), body.model ?? "mock-claude", PINNED_INPUT_TOKENS);
			}
			setTimeout(() => {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Connection error." } }));
			}, 500);
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

function writeSandboxConfig(agentDir, server) {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				anthropic: {
					baseUrl: server.origin,
					apiKey: "sk-mock-qa-7f3a",
					api: "anthropic-messages",
					models: [
						{
							id: "mock-claude",
							api: "anthropic-messages",
							baseUrl: server.origin,
							contextWindow: CONTEXT_WINDOW,
							maxTokens: 4_096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 40 } }));
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
			if (msg && msg.type === "response" && msg.id !== undefined && this.pending.has(msg.id)) {
				this.pending.get(msg.id)(msg);
				this.pending.delete(msg.id);
			} else if (msg && msg.type) {
				this.events.push({ at: Date.now(), msg });
			}
		}
	}

	send(cmd, { timeoutMs = 30_000 } = {}) {
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

	close() {
		try {
			this.child.stdin.end();
		} catch {}
	}
}

async function main() {
	const watchMs = Number(process.argv[process.argv.indexOf("--watch-ms") + 1] || 240_000);
	installCleanupHooks();
	const checks = createChecks("compaction-retry-cycle-repro.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("compaction-retry-cycle");
	const server = await startFlappingServer();
	writeSandboxConfig(box.agentDir, server);

	const client = new RpcClient({ env: hermeticEnv(box.env), cwd: box.cwd });
	const promptOutcomes = [];
	const t0 = Date.now();
	try {
		await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });
		const p1 = await client.send({ type: "prompt", message: "turn one" });
		if (p1.success !== true) throw new Error(`prompt 1 rejected: ${JSON.stringify(p1)}`);
		const deadline = t0 + 60_000;
		for (;;) {
			if (client.events.some((e) => e.msg.type === "agent_end")) break;
			if (Date.now() > deadline) throw new Error("turn 1 never settled");
			await new Promise((r) => setTimeout(r, 50));
		}

		const p2 = await client.send({ type: "prompt", message: "turn two: continue the todo list" });
		console.log("prompt 2 response:", JSON.stringify(p2).slice(0, 300));
		promptOutcomes.push(p2);
		const watchEnd = Date.now() + watchMs;
		let continuations = 0;
		while (Date.now() < watchEnd) {
			await new Promise((r) => setTimeout(r, 3_000));
			continuations++;
			const res = await client.send({ type: "prompt", message: `continuation ${continuations}: next todo` }).catch((e) => String(e));
			promptOutcomes.push(res);
			console.log(`continuation ${continuations} ->`, JSON.stringify(res).slice(0, 220));
		}
	} finally {
		client.close();
	}

	const rel = (at) => `${((at - t0) / 1000).toFixed(1)}s`;
	const compactionStarts = client.events.filter((e) => e.msg.type === "compaction_start");
	const compactionEnds = client.events.filter((e) => e.msg.type === "compaction_end");
	const agentEnds = client.events.filter((e) => e.msg.type === "agent_end");
	const retryEvents = client.events.filter((e) => String(e.msg.type).includes("retry"));
	const summaryReqs = server.requests.filter((r) => r.summarization);
	const turnReqs = server.requests.filter((r) => !r.summarization);

	console.log("--- timeline (events) ---");
	for (const e of client.events.filter((e2) => !["message_update", "message_start"].includes(e2.msg.type))) {
		const m = e.msg;
		const extra =
			m.type === "compaction_end"
				? ` accepted=${m.data?.accepted ?? m.accepted} reason=${m.data?.reason ?? m.reason}`
				: m.type === "compaction_start"
					? ` reason=${m.data?.reason ?? m.reason}`
					: "";
		console.log(`${rel(e.at)} ${m.type}${extra}`);
	}
	console.log("--- timeline (server requests) ---");
	for (const r of server.requests) {
		console.log(`${rel(r.at)} ${r.summarization ? "SUMMARIZATION" : "turn"} ${r.url} system="${r.systemPrefix ?? ""}"`);
	}
	console.log("--- counts ---");
	console.log(`compaction_start=${compactionStarts.length} compaction_end=${compactionEnds.length}`);
	console.log(`agent_end=${agentEnds.length} retryEvents=${retryEvents.length}`);
	console.log(`summarization requests=${summaryReqs.length} turn requests=${turnReqs.length}`);

	const openSpinner = compactionStarts.length > compactionEnds.length;
	checks.ok("every compaction_start has a matching compaction_end (no spinner leak)", !openSpinner);
	const isCompactionRejection = (outcome) =>
		typeof outcome === "object" && outcome !== null && String(outcome.error ?? "").includes("compaction");
	const afterTrip = promptOutcomes.slice(3);
	const compactionBlocked = afterTrip.filter(isCompactionRejection);
	checks.ok(
		"once the breaker is tripped, no prompt is rejected because compaction is unavailable",
		compactionBlocked.length === 0 && afterTrip.length > 0,
		`compactionRejectionsAfterTrip=${compactionBlocked.length}/${afterTrip.length}`,
	);
	checks.ok(
		"turns keep reaching the provider instead of dying at admission",
		turnReqs.length >= 3,
		`turnRequests=${turnReqs.length}`,
	);
	checkRealAuthUnchanged(checks, guard);

	await server.stop();
	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

await main();
