#!/usr/bin/env node
/**
 * Absolute compaction cap QA scenario.
 *
 * Drives the real senpi CLI from source over RPC with a local fake Anthropic
 * server and proves the post-#728 admission policy end to end:
 *   - compactions past the former per-turn soft cap (3) are admitted and
 *     accepted up to the absolute session cap (10),
 *   - the 11th compaction is rejected with the absolute-session-cap message
 *     (not the misleading per-turn wording), and
 *   - the rejection is non-fatal: the session keeps serving prompts.
 *
 * Usage: node compaction-absolute-cap-qa.mjs --self-test [--evidence SLUG]
 */

import { writeFileSync } from "node:fs";
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
import { checkRealAuthUnchanged, hermeticEnv } from "../lib/mock-loop-support.mjs";

const SUMMARY_MARKER = "context summarization assistant";
const ABSOLUTE_CAP = 10;
const FORMER_SOFT_CAP = 3;
const REJECTION_NEEDLE = "absolute compaction cap reached for this session";
const CONTEXT_WINDOW = 128_000;

function flag(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeAnthropicSse(res, text, modelId, inputTokens) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
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

function startScriptedServer() {
	const requests = [];
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
			requests.push({ at: Date.now(), summarization: isSummarization });
			if (isSummarization) {
				return writeAnthropicSse(
					res,
					"## Goal\nQA compaction summary\n## Constraints\nnone\n## State\nabsolute-cap qa",
					body.model ?? "mock-claude",
					500,
				);
			}
			return writeAnthropicSse(res, `QA-TURN-OK-${requests.length}`, body.model ?? "mock-claude", 1_000);
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
					apiKey: "sk-mock-qa-cap",
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

	async waitForEvent(predicate, afterIndex, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = this.events.slice(afterIndex).find((e) => predicate(e.msg));
			if (hit) return hit.msg;
			if (Date.now() > deadline) throw new Error(`event wait timed out (stderr: ${this.stderr.slice(-400)})`);
			await new Promise((r) => setTimeout(r, 25));
		}
	}

	close() {
		try {
			this.child.stdin.end();
		} catch {}
	}
}

async function runPrompt(client, message) {
	const afterIndex = client.events.length;
	const ack = await client.send({ type: "prompt", message });
	const terminal = await client.waitForEvent(
		(m) => m.type === "agent_end" || m.type === "agent_aborted",
		afterIndex,
		30_000,
	);
	return { ack, terminal };
}

async function main() {
	if (!process.argv.includes("--self-test")) {
		process.stderr.write("usage: compaction-absolute-cap-qa.mjs --self-test [--evidence SLUG]\n");
		process.exitCode = 2;
		return;
	}

	installCleanupHooks();
	const checks = createChecks("compaction-absolute-cap-qa.mjs --self-test");
	const evidence = evidenceDir(flag("--evidence") ?? "compaction-absolute-cap");
	const guard = guardRealAuth();
	const box = makeSandbox("senpi-qa-compaction-absolute-cap");
	const observed = { compactOutcomes: [], rejection: null, promptAfterRejection: null };
	let server;
	let client;

	try {
		server = await startScriptedServer();
		writeSandboxConfig(box.agentDir, server);
		client = new RpcClient({ env: hermeticEnv(box.env), cwd: box.cwd });

		await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });
		const seed = await runPrompt(client, `seed turn for compaction qa: ${"lorem ipsum ".repeat(400)}`);
		checks.ok("seed turn completed through agent_end", seed.terminal.type === "agent_end");

		let accepted = 0;
		for (let round = 1; accepted < ABSOLUTE_CAP && round <= ABSOLUTE_CAP + 3; round++) {
			const result = await client.send({ type: "compact" });
			observed.compactOutcomes.push({ round, success: result.success === true, error: result.error ?? null });
			if (result.success === true) accepted++;
			await runPrompt(client, `post-compact filler ${round}: ${"qa content ".repeat(120)}`);
		}
		checks.ok(
			`${ABSOLUTE_CAP} compactions were accepted in one session (former soft cap was ${FORMER_SOFT_CAP})`,
			accepted === ABSOLUTE_CAP,
			`accepted=${accepted}`,
		);

		const rejected = await client.send({ type: "compact" });
		observed.rejection = { success: rejected.success, error: rejected.error ?? null };
		checks.ok("compaction past the absolute cap is rejected", rejected.success === false);
		checks.ok(
			"the rejection names the absolute session cap, not the per-turn cap",
			String(rejected.error ?? "").includes(REJECTION_NEEDLE),
			`error=${String(rejected.error ?? "").slice(0, 160)}`,
		);

		const afterRejection = await runPrompt(client, "post-rejection prompt: the session must keep working");
		observed.promptAfterRejection = afterRejection.terminal.type;
		checks.ok(
			"the cap rejection is non-fatal: the next prompt completes through agent_end",
			afterRejection.ack.success === true && afterRejection.terminal.type === "agent_end",
		);
	} finally {
		client?.close();
		await server?.stop();
	}

	checkRealAuthUnchanged(checks, guard);
	writeFileSync(join(evidence, "observed.json"), `${JSON.stringify(observed, null, 2)}\n`);
	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

await main();
