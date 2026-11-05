#!/usr/bin/env node
// senpi#5481: a warm summary generated below the threshold survives later turns and is applied at the
// threshold without a second summarization request.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createChecks, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot } from "../lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const CONTEXT_WINDOW = 200_000;
const TURN_INPUT_TOKENS = [105_000, 115_000, 120_000, 145_000];
const SUMMARY_MARKER = "WARM SUMMARY FROM TURN ONE";

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

function writeAnthropicSse(res, text, modelId, inputTokens) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
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
	const promise = new Promise((next) => {
		resolvePromise = next;
	});
	return { promise, resolve: resolvePromise };
}

function isSummarizationRequest(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	return JSON.stringify(messages[messages.length - 1]?.content ?? "").includes("INTERNAL COMPACTION INSTRUCTION");
}

async function startProvider() {
	const requests = [];
	const firstSummaryRequested = deferred();
	const releaseFirstSummary = deferred();
	let turns = 0;
	let summaries = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", async () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
			const model = body.model ?? "mock-claude";
			if (isSummarizationRequest(body)) {
				summaries++;
				const index = summaries;
				requests.push({ at: Date.now(), kind: "summarization", index });
				if (index === 1) {
					firstSummaryRequested.resolve();
					await releaseFirstSummary.promise;
				}
				writeAnthropicSse(res, index === 1 ? SUMMARY_MARKER : `SUMMARY ${index}`, model, 1_000);
				return;
			}
			turns++;
			requests.push({ at: Date.now(), kind: "turn", index: turns });
			writeAnthropicSse(res, `reply ${turns}`, model, TURN_INPUT_TOKENS[Math.min(turns, TURN_INPUT_TOKENS.length) - 1]);
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
		firstSummaryRequested: firstSummaryRequested.promise,
		releaseFirstSummary: () => releaseFirstSummary.resolve(),
		summarizationCount: () => summaries,
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
					apiKey: "sk-mock-warm-reuse",
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
			compaction: { enabled: true, speculativeEnabled: true, idleCompactionEnabled: true, keepRecentTokens: 40 },
		}),
	);
}

function readSessionEntries(sessionDir) {
	const file = readdirSync(sessionDir).find((name) => name.endsWith(".jsonl"));
	if (!file) return [];
	return readFileSync(join(sessionDir, file), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function waitForCompactionEntry(sessionDir, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const compactions = readSessionEntries(sessionDir).filter((entry) => entry.type === "compaction");
		if (compactions.length > 0) return compactions;
		await new Promise((next) => setTimeout(next, 200));
	}
	return [];
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("speculative-warm-reuse-qa.mjs");
	const guard = guardRealAuth();
	const targetRoot = resolve(arg("--target-root", repoRoot()));
	const label = arg("--evidence", "after-fix");
	const box = makeSandbox("speculative-warm-reuse");
	const provider = await startProvider();
	writeConfig(box.agentDir, provider);
	const client = new TargetRpcClient({ env: hermeticEnv(box.env), cwd: box.cwd, targetRoot });

	const logPath = join(box.agentDir, "logs", "compaction.log");
	const dumpOnFailure = () => {
		console.log("[qa] compaction.log so far:\n" + (existsSync(logPath) ? readFileSync(logPath, "utf8") : "(none)"));
		console.log("[qa] provider requests: " + JSON.stringify(provider.requests));
		console.log("[qa] events: " + client.events.map((event) => event.message.type).join(","));
		console.log("[qa] stderr tail:\n" + (client.stderr ?? "").slice(-3000));
	};
	const turn = async (message) => {
		console.log(`[qa] prompt: ${message}`);
		const sentAt = Date.now();
		const ended = client.waitFor((event) => event.message.type === "agent_end" && event.at >= sentAt);
		await client.send({ type: "prompt", message });
		await ended;
	};

	try {
		await client.send({ type: "set_model", provider: "anthropic", modelId: "mock-claude" });
		await turn("turn one");
		await provider.firstSummaryRequested;
		console.log("[qa] warm summary requested after turn one (held by the provider)");
		await turn("turn two grows the session past keepRecentTokens");
		console.log("[qa] turn two ended while the warm summary was still running");
		provider.releaseFirstSummary();
		await turn("turn three");
		await turn("turn four crosses the threshold");
		const compactions = await waitForCompactionEntry(box.sessionDir, 30_000);

		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		const logEvents = log
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const names = logEvents.map((entry) => entry.event);
		const summarizations = provider.summarizationCount();

		checks.ok("exactly one summarization request across four turns", summarizations === 1, `count=${summarizations}`);
		const whileTurnsRan = names.slice(names.indexOf("speculative_started"), names.indexOf("idle_trigger"));
		checks.ok(
			"the warm generation survived turns two and three without being invalidated",
			names.includes("speculative_started") && names.includes("idle_trigger") && !whileTurnsRan.includes("speculative_invalidated"),
			names.join(","),
		);
		checks.ok("the finished warm summary was kept, not regenerated", names.includes("speculative_reused"), names.join(","));
		checks.ok("the warm summary was applied at the threshold during the idle gap", names.includes("idle_applied"), names.join(","));
		checks.ok("one durable compaction entry", compactions.length === 1, `count=${compactions.length}`);
		checks.ok(
			"the applied summary is the turn-one warm summary",
			JSON.stringify(compactions).includes(SUMMARY_MARKER),
			"marker present",
		);
		checkRealAuthUnchanged(checks, guard);

		const evidenceDir = join(repoRoot(), "local-ignore", "qa-evidence", "20261102-speculative-warm-reuse", label);
		mkdirSync(evidenceDir, { recursive: true });
		writeFileSync(
			join(evidenceDir, "result.json"),
			JSON.stringify(
				{ targetRoot, summarizations, compactions: compactions.length, logEvents, requests: provider.requests },
				null,
				2,
			),
		);
		writeFileSync(join(evidenceDir, "compaction.log"), log);
		writeFileSync(join(evidenceDir, "child-stderr.log"), client.stderr ?? "");
		console.log(`[qa] evidence: ${evidenceDir}`);
		process.exitCode = checks.finish() ? 0 : 1;
	} catch (error) {
		dumpOnFailure();
		throw error;
	} finally {
		await client.close();
		await provider.stop();
		box.cleanup();
	}
}

await main();
