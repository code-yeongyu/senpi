#!/usr/bin/env node
/**
 * Real RPC/CLI regression QA for #1329, goal-loop shape.
 *
 * Seeds provider-reported context above the proactive compaction threshold
 * (but below the hard reserve valve), then drives an idle goal-continuation
 * trigger turn through the source CLI and asserts the compaction extension
 * compacts BEFORE that turn's provider request, exactly as a typed prompt would.
 * Pass `--target-root <repo>` to drive another checkout (e.g. the pre-fix tag).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";
import { startFakeModelServer } from "../lib/fake-model-server.mjs";
import { hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const SEED_PROMPT = "issue-1329 seed";
const WAKE_PROMPT = "Continue working toward the active thread goal.";
const SEED_REPLY = "ISSUE_1329_SEED_REPLY";
const SUMMARY_REPLY = "ISSUE_1329_SUMMARY_REPLY";
const WAKE_REPLY = "ISSUE_1329_WAKE_REPLY";
const CONTEXT_WINDOW = 128_000;
const SEEDED_PROMPT_TOKENS = 90_000;

function argument(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestMessageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : ""))
		.join("\n");
}

function requestMessages(request) {
	return Array.isArray(request?.body?.messages) ? request.body.messages : [];
}

function requestCarriesWake(request) {
	return requestMessages(request).some((message) => requestMessageText(message) === WAKE_PROMPT);
}

function isSummarizationRequest(request) {
	return requestMessages(request).some((message) => requestMessageText(message).includes("[INTERNAL"));
}

function isWakeTurnRequest(request) {
	return requestCarriesWake(request) && !isSummarizationRequest(request);
}

function requestCarriesUncompactedSeed(request) {
	return requestMessages(request).some(
		(message) => message?.role === "user" && requestMessageText(message) === SEED_PROMPT,
	);
}

function requestCarriesCompactionSummary(request) {
	return requestMessages(request).some((message) => requestMessageText(message).includes(SUMMARY_REPLY));
}

function sanitizedRequests(requests) {
	return requests.map((request) => ({
		method: request.method,
		url: request.url,
		model: request.model,
		carriesWake: requestCarriesWake(request),
		summarization: isSummarizationRequest(request),
		carriesUncompactedSeed: requestCarriesUncompactedSeed(request),
		carriesCompactionSummary: requestCarriesCompactionSummary(request),
		messages: requestMessages(request).map((message) => ({
			role: message?.role,
			preview: requestMessageText(message).replace(/\s+/g, " ").slice(0, 90),
		})),
		authorization: request.authorization ? "<redacted>" : null,
		apiKeyHeader: request.apiKeyHeader ? "<redacted>" : null,
	}));
}

async function main() {
	const selfTest = process.argv.includes("--self-test");
	const evidenceName = argument("--evidence") ?? (selfTest ? "issue-1329-goal-continuation-compaction-self-test" : undefined);
	if (!evidenceName) throw new Error("--evidence <slug> is required unless --self-test is used");
	const targetRoot = argument("--target-root") ?? repoRoot();

	installCleanupHooks();
	const checks = createChecks("issue-1329-goal-continuation-compaction-qa.mjs");
	const authGuard = guardRealAuth();
	const evidence = evidenceDir(evidenceName);
	const box = makeSandbox("issue-1329-goal-compaction-qa");
	let client;
	let server;
	let report = { scenario: "issue-1329-goal-continuation-compaction-qa", selfTest, targetRoot, error: undefined };

	try {
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 1 } }, null, 2),
		);
		server = await startFakeModelServer({
			turns: [{ text: SEED_REPLY, usage: { promptTokens: SEEDED_PROMPT_TOKENS } }, { text: SUMMARY_REPLY }, { text: WAKE_REPLY }],
		});
		writeMockModelsJson(box.agentDir, server, "openai-completions", { contextWindow: CONTEXT_WINDOW });
		client = new TargetRpcClient({ env: hermeticEnv(box.env), cwd: box.cwd, targetRoot });

		const selected = await client.send({ type: "set_model", provider: "mock", modelId: "mock-model" });
		checks.ok("source CLI selected the sandbox fake model", selected.success === true, JSON.stringify(selected));

		const seedSettled = client.waitFor((event) => event.message.type === "agent_settled");
		const seedIdle = client.waitFor((event) => event.message.type === "agent_idle");
		const seeded = await client.send({ type: "prompt", message: SEED_PROMPT });
		await seedSettled;
		await seedIdle;
		checks.ok("seed turn completed with provider-reported usage above the proactive threshold", seeded.success === true, JSON.stringify(seeded));
		const seedRequestCount = server.requests.length;
		checks.ok("exactly one provider request before the wake", seedRequestCount === 1, `count=${seedRequestCount}`);

		const wakeSettled = client.waitFor((event) => event.message.type === "agent_settled");
		const wakeIdle = client.waitFor((event) => event.message.type === "agent_idle");
		const woke = await client.send({
			type: "send_custom_message",
			customType: "goal-continuation",
			content: WAKE_PROMPT,
			display: false,
			triggerTurn: true,
			deliverAs: "followUp",
		});
		await wakeSettled;
		await wakeIdle;
		checks.ok("idle goal-continuation trigger turn completed", woke.success === true, JSON.stringify(woke));

		const wakeRequests = server.requests.filter(isWakeTurnRequest);
		const wakeRequestIndex = server.requests.findIndex(isWakeTurnRequest);
		const seedIdleIndex = client.events.findIndex((event) => event.message.type === "agent_idle");
		const compactionEventIndex = client.events.findIndex((event) => event.message.type === "compaction_start");
		const wakeStartIndex = client.events.findIndex(
			(event, index) => index > seedIdleIndex && event.message.type === "agent_start",
		);
		checks.ok("the wake reached the provider exactly once", wakeRequests.length === 1, `wakeRequests=${wakeRequests.length} firstIndex=${wakeRequestIndex}`);
		checks.ok(
			"the wake's provider request carries the compaction summary instead of the seed prompt",
			wakeRequests.length > 0 &&
				wakeRequests.every((request) => requestCarriesCompactionSummary(request) && !requestCarriesUncompactedSeed(request)),
			`requests=${JSON.stringify(sanitizedRequests(server.requests).map((request) => [request.carriesWake, request.summarization, request.carriesCompactionSummary, request.carriesUncompactedSeed]))}`,
		);
		checks.ok(
			"compaction_start was emitted after the seed turn went idle and before the wake turn started",
			seedIdleIndex >= 0 && compactionEventIndex > seedIdleIndex && wakeStartIndex > compactionEventIndex,
			`seedIdleIndex=${seedIdleIndex} compactionEventIndex=${compactionEventIndex} wakeStartIndex=${wakeStartIndex}`,
		);

		report = {
			...report,
			seededPromptTokens: SEEDED_PROMPT_TOKENS,
			contextWindow: CONTEXT_WINDOW,
			requestCount: server.requests.length,
			wakeRequestIndex,
			seedIdleIndex,
			compactionEventIndex,
			wakeStartIndex,
			requests: sanitizedRequests(server.requests),
			rpcEvents: client.events.map((event) => event.message.type),
		};
	} catch (error) {
		report = { ...report, error: error instanceof Error ? error.message : String(error) };
		checks.ok("scenario completed", false, report.error);
	} finally {
		await client?.close();
		await server?.stop();
		box.cleanup();
		const authUnchanged = authGuard.assertUnchanged();
		checks.ok("real auth unchanged", authUnchanged, authGuard.path);
		const cleanup = {
			clientClosed: client === undefined || client.child.exitCode !== null,
			sandboxRemoved: !existsSync(box.dir),
			realAuthUnchanged: authUnchanged,
		};
		writeFileSync(join(evidence, "issue-1329-goal-continuation-compaction-qa.json"), JSON.stringify({ ...report, cleanup }, null, 2));
		writeFileSync(
			join(evidence, "README.md"),
			[
				"# Issue #1329 QA (goal-loop shape)",
				"",
				"- Real source CLI in RPC mode against a local fake OpenAI server.",
				`- Seed turn reports ${SEEDED_PROMPT_TOKENS} prompt tokens on a ${CONTEXT_WINDOW}-token window (above the proactive threshold, below the hard reserve valve).`,
				"- An idle `goal-continuation` trigger turn must compact before its own provider request: `compaction_start` lands between the seed turn's `agent_idle` and the wake's `agent_start`, and the wake request carries the compacted history instead of the seed assistant reply.",
				"- `issue-1329-goal-continuation-compaction-qa.json` contains sanitized request shapes, RPC event order, and the cleanup receipt.",
				"",
			].join("\n"),
		);
	}

	process.exitCode = checks.finish() ? 0 : 1;
}

await main();
