/**
 * Channel 3 proof (senpi#3637): Anthropic Console spend limits take the billing fast path.
 *
 * The fake server answers every primary-model /messages request with one of the three spend-limit
 * responses documented at https://platform.claude.com/docs/en/api/rate-limits#spend-limits: a limit
 * the user set (400 invalid_request_error "You have reached your specified API usage limits"), a
 * workspace limit (400, "specified workspace API usage limits"), and the tier's monthly cap (429
 * rate_limit_error "You have reached your API usage limits: ..." with error_code
 * enforced_spend_limit_reached and no retry-after). Pre-fix the real CLI fell back as "hard-error"
 * (400) or retried and fell back as "transient" (429), so cooldown-expiry reverted into the spent key.
 * Post-fix each is non-retryable billing: exactly ONE primary request, an immediate pinned fallback
 * (fallback.log records reason "billing"), and the fallback model streams the final marker.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "./lib/common.mjs";
import {
	API_PRESETS,
	checkRealAuthUnchanged,
	hermeticEnv,
	writeMockModelsJson,
} from "./lib/mock-loop-support.mjs";

const FINAL_MARKER = "SENPI-QA-SPEND-LIMIT-FALLBACK-RECOVERED-3637";
const EVIDENCE_SLUG = "anthropic-spend-limit-billing-fallback";
const FALLBACK_MODEL_ID = "mock-model-fallback";
// A spend limit binds the whole Anthropic account, so the chain must leave the provider: a fallback
// on the same provider is skipped as spent (usageLimitScope "account").
const FALLBACK_PROVIDER = "mock-fallback";

const SPEND_LIMIT_CASES = [
	{
		name: "specified-api-usage-limits-400",
		status: 400,
		body: '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."},"request_id":"req_mock_spend_limit"}',
	},
	{
		name: "specified-workspace-api-usage-limits-400",
		status: 400,
		body: '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."},"request_id":"req_mock_workspace_spend_limit"}',
	},
	{
		name: "tier-spend-cap-429",
		status: 429,
		body: '{"type":"error","error":{"type":"rate_limit_error","message":"You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization\'s API tier. You will regain access on 2026-11-01 at 00:00 UTC.","details":{"error_code":"enforced_spend_limit_reached"}},"request_id":"req_mock_tier_spend_cap"}',
	},
];

function anthropicSseText(model, text) {
	const message = {
		id: "msg_mock_credits",
		type: "message",
		role: "assistant",
		model,
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 12, output_tokens: 4 },
	};
	return [
		`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { ...message, content: [], stop_reason: null } })}\n`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })}\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
	].join("\n");
}

function startServer(spendCase) {
	const requests = [];
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			let model = "unknown";
			try {
				model = JSON.parse(body).model ?? "unknown";
			} catch {}
			requests.push({ url: request.url, model });
			if (model !== FALLBACK_MODEL_ID) {
				response.writeHead(spendCase.status, { "content-type": "application/json" });
				response.end(spendCase.body);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(anthropicSseText(FALLBACK_MODEL_ID, FINAL_MARKER));
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Failed to resolve fake server port"));
				return;
			}
			resolve({
				origin: `http://127.0.0.1:${address.port}`,
				port: address.port,
				requests,
				stop: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

function readFallbackLog(agentDir) {
	try {
		return readFileSync(join(agentDir, "logs", "fallback.log"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return { event: "unparsed", raw: line };
				}
			});
	} catch {
		return [];
	}
}

async function runCase(checks, spendCase) {
	const box = makeSandbox(`mock-loop-spend-limit-${spendCase.name}`);
	const server = await startServer(spendCase);
	try {
		const preset = API_PRESETS["anthropic-messages"];
		writeMockModelsJson(box.agentDir, server, "anthropic-messages");
		const modelsPath = join(box.agentDir, "models.json");
		const models = JSON.parse(readFileSync(modelsPath, "utf8"));
		const primaryProvider = models.providers[preset.provider];
		models.providers[FALLBACK_PROVIDER] = {
			...primaryProvider,
			models: [{ ...primaryProvider.models[0], id: FALLBACK_MODEL_ID }],
		};
		writeFileSync(modelsPath, JSON.stringify(models, null, 2));
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify(
				{
					retry: {
						enabled: true,
						maxRetries: 3,
						baseDelayMs: 1,
						provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
						fallbackChains: {
							[`${preset.provider}/${preset.modelId}`]: [`${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID}`],
						},
					},
				},
				null,
				2,
			),
		);
		const startedAt = Date.now();
		const result = await runCli(
			[
				"--provider",
				preset.provider,
				"--model",
				preset.modelId,
				"--no-context-files",
				"--no-extensions",
				"--print",
				`Return ${FINAL_MARKER} after the provider recovers.`,
			],
			{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 60000 },
		);
		const elapsedMs = Date.now() - startedAt;
		const combined = `${result.stdout}\n${result.stderr}`;
		const markerCount = combined.split(FINAL_MARKER).length - 1;
		const primaryRequests = server.requests.filter((request) => request.model === preset.modelId).length;
		const fallbackRequests = server.requests.filter((request) => request.model === FALLBACK_MODEL_ID).length;
		const applied = readFallbackLog(box.agentDir).filter((entry) => entry.event === "fallback_applied");
		const billingApplied = applied.filter((entry) => entry.reason === "billing");
		checks.ok(
			`${spendCase.name} falls back on the billing fast path through the real CLI`,
			result.code === 0 &&
				!result.timedOut &&
				markerCount >= 1 &&
				primaryRequests === 1 &&
				fallbackRequests === 1 &&
				billingApplied.length === 1 &&
				elapsedMs < 45000,
			`code=${result.code} marker=${markerCount} primary=${primaryRequests} fallback=${fallbackRequests} reasons=${JSON.stringify(applied.map((entry) => entry.reason))} elapsedMs=${elapsedMs}`,
		);
		const dir = evidenceDir(EVIDENCE_SLUG);
		writeFileSync(join(dir, `${spendCase.name}-stdout.txt`), result.stdout);
		writeFileSync(join(dir, `${spendCase.name}-stderr.txt`), result.stderr);
		writeFileSync(
			join(dir, `${spendCase.name}-summary.json`),
			`${JSON.stringify(
				{
					command: "node .agents/skills/senpi-qa/scripts/mock-loop-spend-limit-fallback.mjs",
					case: spendCase.name,
					exitCode: result.code,
					timedOut: result.timedOut,
					elapsedMs,
					requests: server.requests,
					fallbackLog: applied,
					finalMarkerCount: markerCount,
				},
				null,
				2,
			)}\n`,
		);
	} finally {
		await server.stop();
		box.cleanup();
	}
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-spend-limit-fallback.mjs");
	const guard = guardRealAuth();
	for (const spendCase of SPEND_LIMIT_CASES) await runCase(checks, spendCase);
	checkRealAuthUnchanged(checks, guard);
	process.exitCode = checks.finish() ? 0 : 1;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
