/**
 * Channel 3 proof that provider-stream stalls use the shared retry budget.
 *
 * The fake server accepts every primary-model request, writes SSE headers, and
 * then sends nothing, reproducing the hung-gateway class where the agent stream
 * idle watchdog trips with zero events. A stall is an ordinary transient
 * failure, so the real source CLI must spend the configured same-model budget
 * (`retry.maxRetries`, i.e. 1 initial request + 3 retries) before escalating to
 * the configured fallback model, which streams the final marker.
 *
 * This is the real-CLI proof for the reported
 * `Retry failed after 1 attempts: Provider stream start timed out after 30000ms`:
 * the stall class previously surrendered the same-model budget after a single
 * retry probe.
 */

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
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

const FINAL_MARKER = "SENPI-QA-STALL-FALLBACK-RECOVERED-91c2";
const EVIDENCE_SLUG = "provider-stream-stall-fallback";
const FALLBACK_MODEL_ID = "mock-model-fallback";
const IDLE_TIMEOUT_MS = 1500;
const MAX_RETRIES = 3;
const EXPECTED_PRIMARY_REQUESTS = MAX_RETRIES + 1;

function startServer() {
	const requests = [];
	const hungResponses = new Set();
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
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			if (model !== FALLBACK_MODEL_ID) {
				hungResponses.add(response);
				response.once("close", () => hungResponses.delete(response));
				return;
			}
			const base = {
				id: "chatcmpl-stall-fallback",
				object: "chat.completion.chunk",
				created: 0,
				model: FALLBACK_MODEL_ID,
			};
			const send = (delta, finishReason = null) => {
				response.write(
					`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
				);
			};
			send({ role: "assistant", content: "" });
			send({ content: FINAL_MARKER });
			send({}, "stop");
			response.end("data: [DONE]\n\n");
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
				url: `http://127.0.0.1:${address.port}/v1`,
				port: address.port,
				requests,
				stop: () =>
					new Promise((done) => {
						for (const response of hungResponses) response.destroy();
						hungResponses.clear();
						server.close(done);
					}),
			});
		});
	});
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-stall-fallback.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("mock-loop-stall-fallback");
	const server = await startServer();
	try {
		const preset = API_PRESETS["openai-completions"];
		writeMockModelsJson(box.agentDir, server, "openai-completions", {}, { models: [{ id: FALLBACK_MODEL_ID }] });
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify(
				{
					httpIdleTimeoutMs: IDLE_TIMEOUT_MS,
					retry: {
						enabled: true,
						maxRetries: MAX_RETRIES,
						baseDelayMs: 1,
						provider: { maxRetries: 0, maxRetryDelayMs: 60000 },
						fallbackChains: {
							[`${preset.provider}/${preset.modelId}`]: [`${preset.provider}/${FALLBACK_MODEL_ID}`],
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
		const pass =
			result.code === 0 &&
			!result.timedOut &&
			markerCount >= 1 &&
			primaryRequests === EXPECTED_PRIMARY_REQUESTS &&
			fallbackRequests === 1 &&
			elapsedMs < 45000;
		checks.ok(
			"the real CLI spends the shared same-model retry budget on stalls before falling back",
			pass,
			`code=${result.code} marker=${markerCount} primary=${primaryRequests} (expected ${EXPECTED_PRIMARY_REQUESTS}) fallback=${fallbackRequests} elapsedMs=${elapsedMs}`,
		);
		checkRealAuthUnchanged(checks, guard);
		const dir = evidenceDir(EVIDENCE_SLUG);
		writeFileSync(join(dir, "stall-fallback-stdout.txt"), result.stdout);
		writeFileSync(join(dir, "stall-fallback-stderr.txt"), result.stderr);
		writeFileSync(
			join(dir, "stall-fallback-summary.json"),
			`${JSON.stringify(
				{
					command: "node .agents/skills/senpi-qa/scripts/mock-loop-stall-fallback.mjs",
					idleTimeoutMs: IDLE_TIMEOUT_MS,
					maxRetries: MAX_RETRIES,
					expectedPrimaryRequests: EXPECTED_PRIMARY_REQUESTS,
					exitCode: result.code,
					timedOut: result.timedOut,
					elapsedMs,
					serverPort: server.port,
					requests: server.requests,
					finalMarkerCount: markerCount,
					pass,
				},
				null,
				2,
			)}\n`,
		);
		process.exitCode = checks.finish() ? 0 : 1;
	} finally {
		await server.stop();
		box.cleanup();
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
