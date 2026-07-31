#!/usr/bin/env node

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
const NEXT_PROMPT = "NEXT PROMPT";
const NEXT_REPLY = "REPLY DELIVERED";

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
				firstSummary.resolve();
				writeAnthropicSse(res, "IDLE SUMMARY", body.model ?? "mock-claude", 1_000);
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
	const checks = createChecks("idle-compaction-bracket-repro.mjs");
	const guard = guardRealAuth();
	const targetRoot = resolve(arg("--target-root", repoRoot()));
	const expectation = arg("--expect-position", "after");
	const label = arg("--evidence", "idle-compaction-bracket-after-fix");
	const box = makeSandbox("idle-compaction-bracket");
	const provider = await startProvider();
	writeConfig(box.agentDir, provider);
	const client = new TargetRpcClient({ env: hermeticEnv(box.env), cwd: box.cwd, targetRoot });

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
		console.log("[qa] idle summary request observed");
		const secondPromptAt = Date.now();
		const startsBeforeSecond = client.events.filter(
			(event) => event.message.type === "compaction_start" && event.at < secondPromptAt,
		).length;

		const secondEnd = client.waitFor((event) => event.message.type === "agent_end" && event.at >= secondPromptAt);
		await client.send({ type: "prompt", message: NEXT_PROMPT });
		console.log("[qa] second prompt accepted");
		await secondEnd;
		console.log("[qa] second agent_end observed");
		const entries = readSessionEntries(box.sessionDir);
		const compactions = entries.filter((entry) => entry.type === "compaction");
		const nextPromptCount = JSON.stringify(entries).split(NEXT_PROMPT).length - 1;
		const replyDelivered = JSON.stringify(entries).includes(NEXT_REPLY);

		checks.ok("exactly one durable compaction", compactions.length === 1, `count=${compactions.length}`);
		checks.ok("next prompt persisted once", nextPromptCount === 1, `count=${nextPromptCount}`);
		checks.ok("second reply delivered", replyDelivered, `replyDelivered=${replyDelivered}`);
		checks.ok(
			`compaction occurs ${expectation} second prompt`,
			expectation === "before" ? startsBeforeSecond === 1 : startsBeforeSecond === 0,
			`startsBeforeSecond=${startsBeforeSecond}`,
		);
		checkRealAuthUnchanged(checks, guard);

		const evidenceDir = join(repoRoot(), "local-ignore", "qa-evidence", "20260731-idle-compaction-bracket", label);
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(
			join(evidenceDir, "result.json"),
			JSON.stringify(
				{
					targetRoot,
					expectation,
					startsBeforeSecond,
					compactions: compactions.length,
					nextPromptCount,
					replyDelivered,
					requests: provider.requests,
					events: client.events.map((event) => ({ at: event.at, type: event.message.type })),
				},
				null,
				2,
			),
		);
		process.exitCode = checks.finish() ? 0 : 1;
	} finally {
		await client.close();
		await provider.stop();
		box.cleanup();
	}
}

await main();
