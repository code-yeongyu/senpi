#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createChecks, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot } from "../lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const CONTEXT_WINDOW = 128_000;
const PINNED_INPUT_TOKENS = 95_000;
const NEXT_PROMPT = "NEXT PROMPT";
const NEXT_REPLY = "REPLY DELIVERED";
const SUMMARY_MARKER = "IDLE SUMMARY";

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
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
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

function isSummarizationRequest(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const last = messages[messages.length - 1];
	const text = JSON.stringify(last?.content ?? "");
	return text.includes("compact") || text.includes("summar");
}

async function startProvider() {
	const requests = [];
	const firstSummary = deferred();
	let summarizationCount = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const summarization = isSummarizationRequest(body);
			const turnIndex = requests.length + 1;
			if (summarization) {
				summarizationCount++;
				requests.push({ at: Date.now(), turnIndex, kind: "summarization" });
				console.log(`[qa] summarization request #${summarizationCount}`);
				firstSummary.resolve();
				writeAnthropicSse(res, SUMMARY_MARKER, body.model ?? "mock-claude", 1_000);
				return;
			}
			requests.push({ at: Date.now(), turnIndex, kind: "turn" });
			const firstTurn = requests.filter((entry) => entry.kind === "turn").length === 1;
			writeAnthropicSse(
				res,
				firstTurn ? "x".repeat(40_000) : NEXT_REPLY,
				body.model ?? "mock-claude",
				firstTurn ? PINNED_INPUT_TOKENS : 1_000,
			);
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
		summarizationCount: () => summarizationCount,
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
					apiKey: "sk-mock-warm-anchor",
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
	const checks = createChecks("warm-summary-anchor-qa.mjs");
	const guard = guardRealAuth();
	const targetRoot = resolve(arg("--target-root", repoRoot()));
	const label = arg("--evidence", "after-fix");
	const box = makeSandbox("warm-summary-anchor");
	const provider = await startProvider();
	writeConfig(box.agentDir, provider);
	const client = new TargetRpcClient({ env: hermeticEnv(box.env), cwd: box.cwd, targetRoot });

	try {
		await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });
		const firstEnd = client.waitFor((event) => event.message.type === "agent_end");
		await client.send({ type: "prompt", message: "turn one" });
		await firstEnd;
		console.log("[qa] first agent_end observed");
		await provider.firstSummary;
		console.log("[qa] idle warm-up summarization observed");
		const summarizationsAfterWarmup = provider.summarizationCount();

		await client.send({ type: "follow_up", message: "idle-time note while the session waits" });
		console.log("[qa] idle-time append delivered (revision bumped)");

		const secondPromptAt = Date.now();
		const secondEnd = client.waitFor((event) => event.message.type === "agent_end" && event.at >= secondPromptAt);
		await client.send({ type: "prompt", message: NEXT_PROMPT });
		await secondEnd;
		console.log("[qa] second agent_end observed");

		const summarizationsTotal = provider.summarizationCount();
globalThis.compactionLogPath = join(box.agentDir, "logs", "compaction.log");
globalThis.compactionLog = existsSync(compactionLogPath) ? readFileSync(compactionLogPath, "utf8") : "";
globalThis.logEvents = compactionLog
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.map((entry) => entry.event);
globalThis.warmApplied = logEvents.includes("speculative_applied");
globalThis.warmStale = logEvents.includes("speculative_stale");
		const entries = readSessionEntries(box.sessionDir);
		const compactions = entries.filter((entry) => entry.type === "compaction");
		const serialized = JSON.stringify(entries);

		checks.ok("idle warm-up billed exactly one summarization", summarizationsAfterWarmup === 1, `count=${summarizationsAfterWarmup}`);
		checks.ok(
			"warm summary reused instead of re-billed on the user's prompt",
			summarizationsTotal === summarizationsAfterWarmup,
			`afterWarmup=${summarizationsAfterWarmup} total=${summarizationsTotal}`,
		);
		checks.ok("compaction log records speculative_applied", warmApplied, `events=${logEvents.join(",")}`);
		checks.ok("compaction log records no speculative_stale", !warmStale, `events=${logEvents.join(",")}`);
		checks.ok("exactly one durable compaction", compactions.length === 1, `count=${compactions.length}`);
		checks.ok("warm summary is the applied summary", serialized.includes(SUMMARY_MARKER), "marker present");
		checks.ok("second reply delivered", serialized.includes(NEXT_REPLY), "reply present");
		checkRealAuthUnchanged(checks, guard);

		const evidenceDir = join(repoRoot(), "local-ignore", "qa-evidence", "20260813-warm-summary-anchor", label);
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(
			join(evidenceDir, "result.json"),
			JSON.stringify(
				{
					targetRoot,
					summarizationsAfterWarmup,
					summarizationsTotal,
					compactions: compactions.length,
					logEvents,
					requests: provider.requests,
					events: client.events.map((event) => ({ at: event.at, type: event.message.type })),
				},
				null,
				2,
			),
		);
		writeFileSync(join(evidenceDir, "child-stderr.log"), client.stderr ?? "");
		process.exitCode = checks.finish() ? 0 : 1;
	} finally {
		await client.close();
		await provider.stop();
		box.cleanup();
	}
}

await main();
