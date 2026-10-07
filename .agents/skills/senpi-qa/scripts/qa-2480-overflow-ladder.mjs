#!/usr/bin/env node
/**
 * senpi#2480 through the real CLI: a provider that counts the request denser than
 * senpi's estimate rejects the turn as "prompt is too long", and the compacted
 * re-send that keeps the configured tail is still too long. The overflow ladder
 * must climb to its second rung (summary plus the turn being answered) inside the
 * same turn and answer, instead of ending after one compact-and-retry.
 *
 * The fake provider is content-aware: compaction's summarization requests
 * (recognized by their internal instruction) are always answered; every agent
 * turn is counted as `bytes(conversation messages) * factor` and rejected when that
 * exceeds the window. The system message is left out of the count so the scenario
 * does not depend on the size of senpi's own system prompt. An agent turn is only
 * answered when it still carries the turn being answered.
 *
 * The scenario runs twice: once with the bare rejection wording and once with the
 * wording that reports the count, which is what the API sends. Both must be taken as
 * an overflow by the CLI. The count-calibrated pre-dispatch gate belongs to the
 * anthropic-subscription lane only, which this generic-provider run does not reach;
 * test/suite/regressions/2480-anthropic-subscription-cold-seed-overflow-ladder.test.ts
 * covers it through the real lane stream.
 *
 * The long history prompts are passed as `@file` arguments, so no command line
 * carries the ~40 KB text (Windows caps a command line at 32,767 characters).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { cleanupAll, evidenceDir, installCleanupHooks, makeSandbox, realAuthPath, runCli, stripAnsi } from "./lib/common.mjs";
import { hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const WINDOW = 200_000;
const CHUNK = "earlier work on the long task ".repeat(1_334); // ~40 KB, ~10k tokens by senpi's estimate
const RECOVERED = "SENPI-QA-2480-RECOVERED";
const CURRENT_TURN = "SENPI-QA-2480-CONTINUE the task";
// Compaction's summarization requests reuse the agent's system prompt and tools (prompt-cache
// reuse) and append one of these internal instructions; core's fallback prompt is the last one.
const SUMMARY_SIGNATURES = ["INSTRUCTION — NOT CONVERSATION HISTORY]", "You are a context summarization assistant."];

const WORDINGS = {
	bare: () => "prompt is too long",
	counted: (counted) => `prompt is too long: ${counted} tokens > ${WINDOW} maximum`,
};

const results = [];
function check(label, passed, detail) {
	results.push({ label, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
}

function authFingerprint() {
	const path = realAuthPath();
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
}

function startCountingProvider(wording) {
	const state = { factor: 1, log: [] };
	const server = createServer((req, res) => {
		// A CLI killed on timeout closes its socket mid-response; that must fail a check, not crash the run.
		req.on("error", () => {});
		res.on("error", () => {});
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			let request;
			try {
				request = JSON.parse(body || "{}");
			} catch {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "malformed request body", type: "invalid_request_error" } }));
				return;
			}
			const messages = request.messages ?? [];
			const raw = JSON.stringify(messages);
			const summarization = SUMMARY_SIGNATURES.some((signature) => raw.includes(signature));
			const conversation = messages.filter((message) => message.role !== "system" && message.role !== "developer");
			const counted = Buffer.byteLength(JSON.stringify(conversation), "utf8") * state.factor;
			const turns = conversation.length;
			const hasCurrentTurn = raw.includes(CURRENT_TURN);
			const tooLong = !summarization && counted > WINDOW;
			// After the overflow starts, an answer that lost the turn being answered is a failure, not a recovery.
			const lostTurn = !summarization && state.factor > 1 && !hasCurrentTurn;
			if (tooLong || lostTurn) {
				state.log.push({ kind: tooLong ? "rejected" : "lost-turn", counted, turns });
				res.writeHead(400, { "content-type": "application/json" });
				const message = tooLong ? wording(counted) : "the request no longer carries the current turn";
				res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
				return;
			}
			const text = summarization ? "## Goal\nsummary of the earlier work" : `${RECOVERED} answer ${state.log.length}`;
			state.log.push({ kind: summarization ? "summary" : "answered", counted, turns });
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const base = { id: "chatcmpl-qa2480", object: "chat.completion.chunk", created: 0, model: "mock-model" };
			const send = (delta, finish = null) =>
				res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			send({ role: "assistant", content: text });
			send({}, "stop");
			res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			const origin = `http://127.0.0.1:${port}`;
			resolve({ state, origin, url: `${origin}/v1`, stop: () => new Promise((done) => server.close(() => done())) });
		});
	});
}

async function runScenario(name) {
	const box = makeSandbox(`senpi-qa-2480-${name}`);
	const env = hermeticEnv(box.env);
	const provider = await startCountingProvider(WORDINGS[name]);
	const cli = ["--print", "--provider", "mock", "--model", "mock-model"];
	try {
		writeMockModelsJson(box.agentDir, provider, "openai-completions", { contextWindow: WINDOW, maxTokens: 4_096 });

		for (let turn = 1; turn <= 3; turn += 1) {
			const promptFile = join(box.cwd, `turn-${turn}.md`);
			writeFileSync(promptFile, `${CHUNK} (turn ${turn})`);
			const run = await runCli([...cli, ...(turn > 1 ? ["--continue"] : []), `@${promptFile}`], {
				env,
				cwd: box.cwd,
				timeoutMs: 120_000,
			});
			check(`[${name}] history turn ${turn} completes`, run.code === 0 && stripAnsi(run.stdout).includes(RECOVERED), `exit ${run.code}`);
		}

		// From here the provider counts three times denser: the full history and the
		// configured ~20k-token tail both overflow; the summary plus this turn fits.
		provider.state.factor = 3;
		const before = provider.state.log.length;
		const run = await runCli([...cli, "--continue", CURRENT_TURN], { env, cwd: box.cwd, timeoutMs: 180_000 });
		const out = stripAnsi(run.stdout);
		const err = stripAnsi(run.stderr);
		const turnLog = provider.state.log.slice(before);
		const answers = turnLog.filter((entry) => entry.kind !== "summary");
		check(`[${name}] overflowing turn answers inside the same turn`, run.code === 0 && out.includes(RECOVERED), `exit ${run.code}`);
		check(
			`[${name}] the answered request still carried the turn being answered`,
			!turnLog.some((entry) => entry.kind === "lost-turn") && answers.at(-1)?.kind === "answered",
			JSON.stringify(answers),
		);
		check(
			`[${name}] two re-sends were rejected before the answer (full history, then the configured tail)`,
			answers.length === 3 && answers[0].kind === "rejected" && answers[1].kind === "rejected",
			JSON.stringify(answers),
		);
		check(
			`[${name}] each rejection was followed by a compaction`,
			turnLog.every((entry, index) => entry.kind !== "rejected" || turnLog[index + 1]?.kind === "summary"),
			JSON.stringify(turnLog.map((entry) => entry.kind)),
		);
		check(`[${name}] no exhaustion notice`, !/recovery failed after/i.test(out + err), "");
		return [`[${name}] provider log for the overflowing turn: ${JSON.stringify(turnLog)}`, "", "stdout:", out.trim(), "", "stderr:", err.trim()].join("\n");
	} finally {
		await provider.stop();
		box.cleanup();
	}
}

async function main() {
	installCleanupHooks();
	const authBefore = authFingerprint();
	const transcripts = [];
	try {
		for (const name of Object.keys(WORDINGS)) transcripts.push(await runScenario(name));
	} finally {
		cleanupAll();
	}
	check("real auth file untouched", authFingerprint() === authBefore, "");

	const dir = evidenceDir("issue2480-overflow-ladder");
	writeFileSync(
		join(dir, "qa-2480-overflow-ladder.log"),
		[
			"# senpi-qa: #2480 overflow ladder through the real CLI",
			`# date: ${new Date().toISOString()}`,
			"",
			...results.map((entry) => `${entry.passed ? "PASS" : "FAIL"} ${entry.label}${entry.detail ? ` - ${entry.detail}` : ""}`),
			"",
			...transcripts,
			"",
			"cleanup: fake providers closed; sandboxes removed; no tracked child left running",
		].join("\n"),
	);
	console.log(`evidence: ${join(dir, "qa-2480-overflow-ladder.log")}`);
	const failed = results.filter((entry) => !entry.passed);
	if (failed.length > 0) {
		console.error(`${failed.length} check(s) failed`);
		// exitCode, not exit(): a forced exit can truncate piped QA output.
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error);
	cleanupAll();
	process.exitCode = 1;
});
