/**
 * Channel 3 proof for senpi#2376: a transient `forbidden` burst on the subscription
 * provider must not strand a session on a billing-dead fallback provider.
 *
 * One fake Anthropic-compatible server serves two providers that carry the same
 * model ids, like the shipped ladder expanded onto `anthropic` + `anthropic-api`:
 *   /sub  answers the verbatim incident stream error
 *         {"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}
 *         for its first N requests, then streams normally;
 *   /api  answers every request with the verbatim 400 "credit balance is too low".
 *
 * Scenarios (real CLI from this worktree, print mode, isolated agent dir):
 *   retry     N=1: the same model is retried and answers; no fallback at all.
 *   return    N=3 (= 1 + maxRetries): turn 1 falls back to /api, which is billing-dead,
 *             and the chain ends there; turn 2 returns to the original model
 *             (fallback_reverted trigger fallback-unusable) and it answers.
 *   skip      the original keeps failing: /api's first rung answers billing, its second
 *             rung is skipped without a request, and the next /sub rung answers.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "./lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv } from "./lib/mock-loop-support.mjs";

const MARKER = "SENPI-QA-FORBIDDEN-RETURN-2376";
const FORBIDDEN_SSE = 'event: error\ndata: {"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}\n\n';
const CREDIT_BALANCE_400 = JSON.stringify({
	type: "error",
	error: {
		type: "invalid_request_error",
		message:
			"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
	},
	request_id: "req_mock_credit_balance",
});

function anthropicSseText(model, text) {
	const message = { id: "msg_mock_2376", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4 } };
	return [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message })}\n`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
}

function startServer({ forbiddenCount, forbiddenModels }) {
	const requests = [];
	let subRequests = 0;
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			let model = "unknown";
			try {
				model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model ?? "unknown";
			} catch {}
			const lane = request.url?.startsWith("/api") ? "api" : "sub";
			requests.push(`${lane}/${model}`);
			if (lane === "api") {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(CREDIT_BALANCE_400);
				return;
			}
			subRequests += 1;
			const forbidden = forbiddenModels ? forbiddenModels.includes(model) : subRequests <= forbiddenCount;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(forbidden ? FORBIDDEN_SSE : anthropicSseText(model, `${MARKER} from ${lane}/${model}`));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") return reject(new Error("no port"));
			resolve({ origin: `http://127.0.0.1:${address.port}`, requests, stop: () => new Promise((done) => server.close(done)) });
		});
	});
}

function writeConfig(agentDir, origin, chain) {
	const model = (id) => ({ id, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	const provider = (path, apiKey) => ({ baseUrl: `${origin}${path}`, apiKey, api: "anthropic-messages", models: [model("mock-opus-a"), model("mock-opus-b")] });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: provider("/sub", "sk-ant-mock-sub"), "anthropic-api": provider("/api", "sk-ant-mock-api") } }, null, 2));
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 }, fallbackChains: { "anthropic/mock-opus-a": chain } } }, null, 2),
	);
}

function fallbackLog(agentDir) {
	try {
		return readFileSync(join(agentDir, "logs", "fallback.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function scenario(name, serverOptions, chain, prompts) {
	const box = makeSandbox(`qa-2376-${name}`);
	const server = await startServer(serverOptions);
	try {
		writeConfig(box.agentDir, server.origin, chain);
		const result = await runCli(
			["--provider", "anthropic", "--model", "mock-opus-a", "--no-context-files", "--no-extensions", "--print", ...prompts],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 90000 },
		);
		const log = fallbackLog(box.agentDir).filter((entry) => entry.event === "fallback_applied" || entry.event === "fallback_reverted");
		return { name, code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, requests: [...server.requests], log };
	} finally {
		await server.stop();
	}
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-forbidden-fallback-return.mjs");
	const guard = guardRealAuth();
	const retry = await scenario("retry", { forbiddenCount: 1 }, ["anthropic-api/mock-opus-a"], ["Say the marker."]);
	const back = await scenario("return", { forbiddenCount: 3 }, ["anthropic-api/mock-opus-a"], ["First turn.", "Second turn."]);
	const skip = await scenario(
		"skip",
		{ forbiddenModels: ["mock-opus-a"] },
		["anthropic-api/mock-opus-a", "anthropic-api/mock-opus-b", "anthropic/mock-opus-b"],
		["Say the marker."],
	);
	const events = (run) => run.log.map((entry) => `${entry.event}:${entry.from}->${entry.to}:${entry.reason ?? entry.trigger ?? ""}`);

	checks.ok(
		"retry: a reason-less forbidden is retried on the same model and never falls back",
		retry.code === 0 && retry.stdout.includes(`${MARKER} from sub/mock-opus-a`) && JSON.stringify(retry.requests) === JSON.stringify(["sub/mock-opus-a", "sub/mock-opus-a"]) && retry.log.length === 0,
		`code=${retry.code} requests=${JSON.stringify(retry.requests)} log=${JSON.stringify(events(retry))}`,
	);
	checks.ok(
		"return: the session leaves the billing-dead fallback and the original answers the next turn",
		back.stdout.includes(`${MARKER} from sub/mock-opus-a`) &&
			JSON.stringify(back.requests) === JSON.stringify(["sub/mock-opus-a", "sub/mock-opus-a", "sub/mock-opus-a", "api/mock-opus-a", "sub/mock-opus-a"]) &&
			events(back).includes("fallback_reverted:anthropic-api/mock-opus-a->anthropic/mock-opus-a:fallback-unusable") &&
			back.stderr.includes("cannot serve right now"),
		`code=${back.code} requests=${JSON.stringify(back.requests)} log=${JSON.stringify(events(back))}`,
	);
	checks.ok(
		"skip: a billing-dead provider's later rung gets no request and the next healthy rung answers",
		skip.code === 0 &&
			skip.stdout.includes(`${MARKER} from sub/mock-opus-b`) &&
			!skip.requests.includes("api/mock-opus-b") &&
			skip.requests.filter((request) => request === "api/mock-opus-a").length === 1,
		`code=${skip.code} requests=${JSON.stringify(skip.requests)} log=${JSON.stringify(events(skip))}`,
	);
	checkRealAuthUnchanged(checks, guard);

	const dir = evidenceDir("issue-2376-forbidden-fallback-return");
	for (const run of [retry, back, skip]) {
		writeFileSync(join(dir, `${run.name}-stdout.txt`), run.stdout);
		writeFileSync(join(dir, `${run.name}-stderr.txt`), run.stderr);
	}
	writeFileSync(
		join(dir, "summary.json"),
		`${JSON.stringify(
			[retry, back, skip].map((run) => ({ scenario: run.name, exitCode: run.code, timedOut: run.timedOut, requests: run.requests, fallbackLog: run.log })),
			null,
			2,
		)}\n`,
	);
	console.log(`evidence: ${dir}`);
	process.exitCode = checks.finish() ? 0 : 1;
}

await main();
