#!/usr/bin/env node
/**
 * Real-CLI QA for issue #934: an active goal stalls after a settings hot-reload.
 *
 * Flow: prompt one makes the model call create_goal and stop cleanly. The
 * mock then answers every continuation with one identical string, so the
 * goal's own stale-signature guard parks the loop after two continuation
 * turns: goal active, session idle, nothing armed — the exact state a reload
 * used to strand forever. A sandbox extension then drives
 * `ctx.requestReload()` — the SAME entry point the builtin config-reload
 * watcher uses in production — retiring the extension generation mid-park.
 *
 * PASS (fixed source) = at least one provider request arrives AFTER the reload
 * with no user prompt in between (the re-engaged goal continuation), the CLI
 * stays alive, a post-reload user prompt is still answered, and no
 * `stale extension generation` / `uncaughtException` surfaces.
 *
 * RED (origin/main) = zero provider requests in the post-reload window: the
 * goal is parked until the user types. The post-reload sanity prompt still
 * answers, proving the stall is goal-specific, not a dead session.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/goal-reload-reengagement-qa.mjs \
 *     --evidence goal-reload-stall [--target-root /path/to/other/checkout]
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

const GOAL_OBJECTIVE = "QA reload goal";
const NEXT_REPLY = "POST RELOAD REPLY DELIVERED";
const IDENTICAL_OUTPUT = "IDENTICAL GOAL OUTPUT";
// After two identical continuation answers the goal's stale-signature guard
// parks the loop; the reload must land in that idle parked state, and the
// post-reload window must be generous enough for any honest re-arm.
const POST_RELOAD_WINDOW_MS = 18_000;

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

function writeAnthropicToolUseSse(res, modelId) {
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
			usage: { input_tokens: 1_000, output_tokens: 0 },
		},
	});
	event("content_block_start", {
		index: 0,
		content_block: { type: "tool_use", id: "toolu_qa_goal_1", name: "create_goal", input: {} },
	});
	event("content_block_delta", {
		index: 0,
		delta: { type: "input_json_delta", partial_json: JSON.stringify({ objective: GOAL_OBJECTIVE }) },
	});
	event("content_block_stop", { index: 0 });
	event("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 30 } });
	event("message_stop", {});
	res.end();
}

async function startProvider() {
	const requests = [];
	let callIndex = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			callIndex++;
			const lastMessage = Array.isArray(body.messages) ? body.messages.at(-1) : undefined;
			const lastText = JSON.stringify(lastMessage?.content ?? "");
			const isPostReloadPrompt = lastText.includes("POST RELOAD PROMPT");
			requests.push({ at: Date.now(), callIndex, url: req.url, model: body.model, isPostReloadPrompt });
			console.log(`[qa] provider request ${callIndex} postReloadPrompt=${isPostReloadPrompt}`);
			if (callIndex === 1) {
				writeAnthropicToolUseSse(res, body.model ?? "mock-claude");
				return;
			}
			const text = isPostReloadPrompt ? NEXT_REPLY : callIndex === 2 ? "GOAL REGISTERED" : IDENTICAL_OUTPUT;
			writeAnthropicSse(res, text, body.model ?? "mock-claude", 1_000);
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
					apiKey: "sk-mock-goal-reload",
					api: "anthropic-messages",
					models: [
						{
							id: "mock-claude",
							api: "anthropic-messages",
							baseUrl: provider.origin,
							contextWindow: 128_000,
							maxTokens: 4_096,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
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
	const checks = createChecks("goal-reload-reengagement-qa.mjs");
	const guard = guardRealAuth();
	const targetRoot = resolve(arg("--target-root", repoRoot()));
	const label = arg("--evidence", "goal-reload-stall");
	const box = makeSandbox("goal-reload-reengagement");
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
		await client.send({ type: "prompt", message: "turn one: register the goal" });
		console.log("[qa] first prompt accepted");
		await firstEnd;
		console.log("[qa] first agent_end observed (goal active, continuation loop running)");

		// Wait for the goal loop to park itself: the identical continuation
		// answers trip the stale-signature guard, leaving the goal active with
		// the session idle and nothing armed. Quiescence = no new provider
		// request for a quiet stretch after at least the two continuation turns.
		let lastCount = 0;
		let quietSince = Date.now();
		while (client.child.exitCode === null) {
			const count = provider.requests.length;
			if (count !== lastCount) {
				lastCount = count;
				quietSince = Date.now();
			} else if (count >= 3 && Date.now() - quietSince >= 2_000) {
				break;
			}
			await new Promise((resolveTick) => setTimeout(resolveTick, 200));
		}
		const requestsBeforeReload = provider.requests.length;
		console.log(`[qa] goal loop parked at ${requestsBeforeReload} provider requests; reloading`);
		const reloadResponse = await client.send({ type: "extension_request", name: "qa.reload", data: null }, 60_000);
		console.log(`[qa] reload requested: ${JSON.stringify(reloadResponse?.data ?? reloadResponse)}`);

		// Watch for goal-driven provider requests after the reload with no user
		// prompt. Fixed source: the re-engagement queues a continuation almost
		// immediately. Unfixed: nothing ever arrives (the stall).
		const deadline = Date.now() + POST_RELOAD_WINDOW_MS;
		let postReloadRequests = 0;
		while (Date.now() < deadline && client.child.exitCode === null) {
			postReloadRequests = provider.requests.length - requestsBeforeReload;
			if (postReloadRequests > 0) break;
			await new Promise((resolveTick) => setTimeout(resolveTick, 250));
		}
		postReloadRequests = provider.requests.length - requestsBeforeReload;
		const aliveAfterWindow = client.child.exitCode === null;
		console.log(`[qa] post-reload window: postReloadRequests=${postReloadRequests} alive=${aliveAfterWindow}`);

		// Sanity: the session itself still answers a real user prompt after the
		// reload, so a missing continuation is a goal stall, not a dead session.
		// Wait for the continuation turn to fully settle first: prompting into
		// the settlement race can strand the queued prompt behind a drain that
		// already ran. Then poll the session entries for the distinct reply
		// instead of racing continuation agent_end events.
		let replyDelivered = false;
		if (aliveAfterWindow) {
			const lastRequestAt = provider.requests.at(-1)?.at ?? Date.now();
			const settleDeadline = Date.now() + 10_000;
			while (Date.now() < settleDeadline && client.child.exitCode === null) {
				const settled = client.events.some(
					(event) => event.message.type === "agent_settled" && event.at >= lastRequestAt,
				);
				if (settled) break;
				await new Promise((resolveTick) => setTimeout(resolveTick, 200));
			}
			await client.send({ type: "prompt", message: "POST RELOAD PROMPT" });
			console.log("[qa] post-reload prompt accepted");
			const replyDeadline = Date.now() + 15_000;
			while (Date.now() < replyDeadline && client.child.exitCode === null) {
				try {
					if (JSON.stringify(readSessionEntries(box.sessionDir)).includes(NEXT_REPLY)) {
						replyDelivered = true;
						break;
					}
				} catch {
					// session file may not exist yet
				}
				await new Promise((resolveTick) => setTimeout(resolveTick, 250));
			}
			console.log(`[qa] post-reload reply delivered=${replyDelivered}`);
		}

		const combined = `${client.stderr}\n${readAgentLogs(box.agentDir)}`;
		const staleHits = combined.split("stale extension generation").length - 1;
		const uncaughtHits = combined.split("uncaughtException").length - 1;

		checks.ok("goal continued after reload with no user input", postReloadRequests > 0, `postReloadRequests=${postReloadRequests}`);
		checks.ok("cli survived the reload window", aliveAfterWindow, `exitCode=${client.child.exitCode}`);
		checks.ok("post-reload prompt answered", replyDelivered, `replyDelivered=${replyDelivered}`);
		checks.ok("no stale-generation error surfaced", staleHits === 0, `hits=${staleHits}`);
		checks.ok("no uncaughtException surfaced", uncaughtHits === 0, `hits=${uncaughtHits}`);
		checkRealAuthUnchanged(checks, guard);

		const outDir = join(
			repoRoot(),
			"local-ignore",
			"qa-evidence",
			"20260818-goal-reload-stall",
			label,
		);
		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			join(outDir, "result.json"),
			JSON.stringify(
				{
					targetRoot,
					requestsBeforeReload,
					postReloadRequests,
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
