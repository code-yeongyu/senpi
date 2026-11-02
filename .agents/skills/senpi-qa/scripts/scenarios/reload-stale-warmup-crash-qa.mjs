#!/usr/bin/env node
/**
 * Real-CLI QA for the reload-vs-idle-warm-up crash.
 *
 * Field crash:
 *   pi exiting due to uncaughtException:
 *   Error: stale extension generation after reload
 *       at ExtensionRunner.assertActive (core/extensions/runner.js)
 *       at Object.getContextUsage (core/extensions/runner.js)
 *       at core/extensions/builtin/compaction/index.js
 *
 * The builtin compaction extension arms an idle warm-up retry after a transient
 * summarization failure. `AgentSession.reload()` retires that extension
 * generation, after which every `ExtensionContext` getter throws. The armed
 * continuation and its timer used to read the retired context anyway, which
 * killed the process.
 *
 * Flow: one turn pins the session over the idle threshold; the idle warm-up
 * summarization fails transiently (arming the retry); rewriting the watched
 * `settings.json` makes the builtin config-reload extension call
 * `ctx.requestReload()` (the production reload path); the retry delay then
 * elapses against the retired generation.
 *
 * PASS = the process stays alive, still answers a prompt after the reload, and
 * neither stderr nor the sandbox logs contain `stale extension generation` or
 * `uncaughtException`.
 *
 * SCOPE (verified, do not overclaim): this is a NON-REGRESSION PROBE of the
 * reload path, not a crash reproduction. The reload really does retire the
 * generation here — the `qa.reload` response itself comes back as
 * `stale extension generation after reload` — but a scripted RPC run cannot pin
 * the narrow interleaving the field crash needed: the warm job is invalidated
 * and replaced within ~30ms, so `armIdleWarmupRetry`'s own
 * `speculativeJob !== job` fence returns before the continuation touches the
 * context. Running this scenario against the unfixed source therefore also
 * passes. The faithful reproduction, with a mutation proof, lives in
 * `packages/coding-agent/test/compaction/stale-context-idle-warmup.test.ts`.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/reload-stale-warmup-crash-qa.mjs \
 *     --evidence reload-stale-warmup
 */

import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createChecks,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const CONTEXT_WINDOW = 128_000;
const PINNED_INPUT_TOKENS = 120_000;
const NEXT_PROMPT = "POST RELOAD PROMPT";
const NEXT_REPLY = "POST RELOAD REPLY DELIVERED";
// idle-retry.ts IDLE_WARMUP_RETRY_DELAY_MS is 15s; wait past it so the armed
// timer actually fires while the generation is dead.
const RETRY_WINDOW_MS = 20_000;

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
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
			id: `msg_${Date.now()}`,
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
	event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
	event("message_stop", {});
	res.end();
}

function deferred() {
	let resolvePromise;
	const promise = new Promise((resolveNext) => {
		resolvePromise = resolveNext;
	});
	if (!resolvePromise) throw new Error("deferred resolver missing");
	return { promise, resolve: resolvePromise };
}

async function startProvider() {
	const requests = [];
	const firstSummary = deferred();
	let callIndex = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const systemText = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
			callIndex++;
			const summarization = callIndex === 2;
			requests.push({ at: Date.now(), callIndex, summarization, url: req.url, systemPrefix: systemText.slice(0, 80) });
			console.log(`[qa] provider request ${callIndex} summarization=${summarization}`);
			if (summarization) {
				// Fail the warm-up transiently: this is what arms the idle retry
				// watcher whose continuation later reads the retired context.
				res.writeHead(529, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
				firstSummary.resolve();
				return;
			}
			const text = callIndex === 1 ? "x".repeat(40_000) : NEXT_REPLY;
			const inputTokens = callIndex === 1 ? PINNED_INPUT_TOKENS : 1_000;
			writeAnthropicSse(res, text, body.model ?? "mock-claude", inputTokens);
		});
	});
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("provider address unavailable");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		firstSummary: firstSummary.promise,
		stop: () => new Promise((resolveStop) => server.close(resolveStop)),
	};
}

function writeConfig(agentDir, provider) {
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				anthropic: {
					baseUrl: provider.origin,
					apiKey: "sk-mock-idle-compaction",
					api: "anthropic-messages",
					models: [
						{
							id: "mock-claude",
							api: "anthropic-messages",
							baseUrl: provider.origin,
							contextWindow: CONTEXT_WINDOW,
							maxTokens: 4_096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			compaction: {
				enabled: true,
				speculativeEnabled: true,
				idleCompactionEnabled: true,
				keepRecentTokens: 40,
			},
		}),
	);
}

/**
 * Sandbox extension exposing the host reload action over the RPC
 * `extension_request` channel. `ctx.requestReload()` is the SAME entry point the
 * builtin config-reload watcher uses in production (config-reload/index.ts), so
 * driving it directly exercises the real reload path without depending on the
 * watcher's project-trust gate, which a hermetic sandbox never grants.
 */
function writeReloadExtension(cwd) {
	const dir = join(cwd, "qa-extensions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "qa-reload.ts");
	writeFileSync(
		file,
		[
			"export default function qaReload(pi: any) {",
			"	let latest: any;",
			'	pi.on("session_start", (_event: unknown, ctx: any) => {',
			"		latest = ctx;",
			"	});",
			'	pi.on("agent_end", (_event: unknown, ctx: any) => {',
			"		latest = ctx;",
			"	});",
			'	pi.rpc.handle("qa.reload", async () => {',
			"		if (!latest?.requestReload) return { reloaded: false, reason: \"requestReload unavailable\" };",
			"		await latest.requestReload();",
			"		return { reloaded: true };",
			"	});",
			"}",
			"",
		].join("\n"),
	);
	return file;
}

function readAgentLogs(agentDir) {
	const logsDir = join(agentDir, "logs");
	let text = "";
	try {
		for (const name of readdirSync(logsDir)) text += readFileSync(join(logsDir, name), "utf8");
	} catch {
		return text;
	}
	return text;
}

function readSessionEntries(sessionDir) {
	const file = readdirSync(sessionDir).find((name) => name.endsWith(".jsonl"));
	if (!file) throw new Error(`no session JSONL in ${sessionDir}`);
	return readFileSync(join(sessionDir, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("reload-stale-warmup-crash-qa.mjs");
	const guard = guardRealAuth();
	const targetRoot = resolve(arg("--target-root", repoRoot()));
	const label = arg("--evidence", "reload-stale-warmup");
	const box = makeSandbox("reload-stale-warmup");
	const provider = await startProvider();
	writeConfig(box.agentDir, provider);
	const reloadExtension = writeReloadExtension(box.cwd);
	const client = new TargetRpcClient({
		env: hermeticEnv(box.env),
		cwd: box.cwd,
		targetRoot,
		extraArgs: ["-e", reloadExtension],
	});

	try {
		console.log("[qa] rpc started");
		await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });
		console.log("[qa] model selected");
		const firstEnd = client.waitFor((event) => event.message.type === "agent_end");
		await client.send({ type: "prompt", message: "turn one" });
		console.log("[qa] first prompt accepted");
		await firstEnd;
		console.log("[qa] first agent_end observed");
		await provider.firstSummary;
		console.log("[qa] idle warm-up summarization failed (retry armed)");

		// Production reload path: ctx.requestReload() retires this extension
		// generation exactly as a /reload or a config-watch reload does.
		const reloadResponse = await client.send({ type: "extension_request", name: "qa.reload", data: null }, 60_000);
		console.log(`[qa] reload requested: ${JSON.stringify(reloadResponse?.data ?? reloadResponse)}`);

		// Hold past the 15s retry delay so the armed timer fires against the
		// retired generation. Before the fix this is where the process died.
		const deadline = Date.now() + RETRY_WINDOW_MS;
		while (Date.now() < deadline && client.child.exitCode === null) {
			await new Promise((resolveTick) => setTimeout(resolveTick, 500));
		}
		const aliveAfterWindow = client.child.exitCode === null;
		console.log(`[qa] retry window elapsed aliveAfterWindow=${aliveAfterWindow}`);

		let replyDelivered = false;
		if (aliveAfterWindow) {
			const secondEnd = client.waitFor((event) => event.message.type === "agent_end" && event.at >= deadline);
			await client.send({ type: "prompt", message: NEXT_PROMPT });
			console.log("[qa] post-reload prompt accepted");
			await secondEnd;
			console.log("[qa] post-reload agent_end observed");
			replyDelivered = JSON.stringify(readSessionEntries(box.sessionDir)).includes(NEXT_REPLY);
		}

		const combined = `${client.stderr}\n${readAgentLogs(box.agentDir)}`;
		const staleHits = combined.split("stale extension generation").length - 1;
		const uncaughtHits = combined.split("uncaughtException").length - 1;

		checks.ok("cli survived reload + retry window", aliveAfterWindow, `exitCode=${client.child.exitCode}`);
		checks.ok("post-reload prompt answered", replyDelivered, `replyDelivered=${replyDelivered}`);
		checks.ok("no stale-generation error surfaced", staleHits === 0, `hits=${staleHits}`);
		checks.ok("no uncaughtException surfaced", uncaughtHits === 0, `hits=${uncaughtHits}`);
		checkRealAuthUnchanged(checks, guard);

		const outDir = join(repoRoot(), "local-ignore", "qa-evidence", `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-reload-stale-warmup`, label);
		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			join(outDir, "result.json"),
			JSON.stringify(
				{
					targetRoot,
					aliveAfterWindow,
					replyDelivered,
					staleHits,
					uncaughtHits,
					exitCode: client.child.exitCode,
					requests: provider.requests,
					events: client.events.map((event) => ({ at: event.at, type: event.message.type })),
				},
				null,
				2,
			),
		);
		writeFileSync(join(outDir, "stderr.txt"), client.stderr);
		console.log(`[qa] evidence written to ${outDir}`);
		process.exitCode = checks.finish() ? 0 : 1;
	} finally {
		await client.close();
		await provider.stop();
		box.cleanup();
	}
}

await main();
