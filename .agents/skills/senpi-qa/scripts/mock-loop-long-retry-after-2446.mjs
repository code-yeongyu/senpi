/**
 * Channel 3 proof for senpi#2446: one 429 whose Retry-After is far longer than
 * `fallback.circuitMaxCooldownMs` must not park the chain entry for the whole hint.
 *
 * One fake Anthropic-compatible server:
 *   primary  (mock-opus-a) answers its first request with HTTP 429 and
 *            `retry-after-ms: 85370000` (the ~23.7 h stale wait from the incident),
 *            then streams normally;
 *   fallback (mock-opus-b) streams its answer slowly, so the next turn starts after
 *            the configured ceiling has elapsed.
 *
 * Real CLI from this worktree, print mode, two prompts, isolated agent dir, with the
 * circuit ceiling shortened through the real settings (`circuitCooldownMs` 1 s,
 * `circuitMaxCooldownMs` 3 s). Expected: turn 1 falls back to mock-opus-b; turn 2
 * returns to mock-opus-a, which answers. Before the fix turn 2 stayed on mock-opus-b.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "./lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv } from "./lib/mock-loop-support.mjs";

const MARKER = "SENPI-QA-LONG-RETRY-AFTER-2446";
const STALE_WAIT_MS = "85370000";
const FALLBACK_STREAM_DELAY_MS = 4_000;
const RATE_LIMITED = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "All tokens rate limited" } });

function anthropicSseText(model, text) {
	const message = { id: "msg_mock_2446", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4 } };
	return [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message })}\n`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
}

function startServer() {
	const requests = [];
	let primaryRequests = 0;
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			let model = "unknown";
			let prompt = "";
			try {
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				model = body.model ?? "unknown";
				const last = body.messages?.at(-1)?.content;
				prompt = typeof last === "string" ? last : (last?.find?.((part) => part.type === "text")?.text ?? "");
			} catch {}
			requests.push({ model, prompt: prompt.slice(0, 40) });
			if (model === "mock-opus-a") {
				primaryRequests += 1;
				if (primaryRequests === 1) {
					response.writeHead(429, { "content-type": "application/json", "retry-after-ms": STALE_WAIT_MS });
					response.end(RATE_LIMITED);
					return;
				}
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(anthropicSseText(model, `${MARKER} from ${model}`));
				return;
			}
			const [head, ...rest] = anthropicSseText(model, `${MARKER} from ${model}`).split("\n\n");
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`${head}\n\n`);
			setTimeout(() => response.end(rest.join("\n\n")), FALLBACK_STREAM_DELAY_MS);
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

function writeConfig(agentDir, origin) {
	const model = (id) => ({ id, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({ providers: { anthropic: { baseUrl: origin, apiKey: "sk-ant-mock", api: "anthropic-messages", models: [model("mock-opus-a"), model("mock-opus-b")] } } }, null, 2),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify(
			{
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, provider: { maxRetries: 0 }, fallbackChains: { "anthropic/mock-opus-a": ["anthropic/mock-opus-b"] } },
				fallback: { circuitCooldownMs: 1_000, circuitMaxCooldownMs: 3_000 },
			},
			null,
			2,
		),
	);
}

function fallbackLog(agentDir) {
	try {
		return readFileSync(join(agentDir, "logs", "fallback.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-long-retry-after-2446.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("qa-2446-long-retry-after");
	const server = await startServer();
	let result;
	try {
		writeConfig(box.agentDir, server.origin);
		result = await runCli(
			["--provider", "anthropic", "--model", "mock-opus-a", "--no-context-files", "--no-extensions", "--print", "First turn.", "Second turn."],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 90000 },
		);
	} finally {
		await server.stop();
	}
	const log = fallbackLog(box.agentDir).filter((entry) => /^(fallback_|circuit_)/.test(entry.event ?? ""));
	const requests = [...server.requests];
	const secondTurn = requests.findIndex((entry) => entry.prompt === "Second turn.");
	const opened = log.find((entry) => entry.event === "circuit_opened");

	checks.ok(
		"a 23.7 h Retry-After past the 3 s ceiling: the circuit opens for the ceiling and turn 2 returns to the primary, which answers",
		JSON.stringify(requests.slice(0, 2).map((entry) => entry.model)) === JSON.stringify(["mock-opus-a", "mock-opus-b"]) &&
			secondTurn === 2 &&
			requests[secondTurn]?.model === "mock-opus-a" &&
			opened?.durationMs === 3_000 &&
			result.stdout.includes(`${MARKER} from mock-opus-a`),
		`code=${result.code} requests=${JSON.stringify(requests)} log=${JSON.stringify(log.map((entry) => `${entry.event}:${entry.from ?? entry.selector ?? ""}->${entry.to ?? ""}:${entry.durationMs ?? ""}`))}`,
	);
	checkRealAuthUnchanged(checks, guard);

	const dir = evidenceDir("issue-2446-long-retry-after");
	writeFileSync(join(dir, "stdout.txt"), result.stdout);
	writeFileSync(join(dir, "stderr.txt"), result.stderr);
	writeFileSync(join(dir, "summary.json"), `${JSON.stringify({ exitCode: result.code, timedOut: result.timedOut, requests, fallbackLog: log }, null, 2)}\n`);
	console.log(`evidence: ${dir}`);
	process.exitCode = checks.finish() ? 0 : 1;
}

await main();
