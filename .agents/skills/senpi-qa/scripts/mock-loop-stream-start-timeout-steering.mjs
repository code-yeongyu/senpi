/**
 * Real CLI RED/GREEN scenario: queued steering after provider stream-start
 * retry exhaustion.
 *
 * The fake OpenAI-compatible server answers the first two completion requests
 * with SSE response headers and then never a single event, so the agent loop's
 * real stream-start watchdog fires twice (`retry.maxRetries: 1` means the
 * second timeout exhausts the session retry budget). While the automatic retry
 * is pending (`auto_retry_start`), the QA client injects an RPC steer. GREEN
 * behavior: once the budget is exhausted, the session admits the parked steer
 * by itself — a third provider request whose body carries the steer marker and
 * whose completion returns `SENPI-QA-THIRD-REQUEST-OK-42` — with no second
 * prompt from the client. RED (current bug): the parked steer stays ownerless,
 * no third request is ever made, and the marker never reaches the transcript.
 *
 * Synchronization is event/deferred only (RPC events + a server-side request
 * deferred raced against a bounded deadline); no sleeps, no polling.
 */

import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import {
	createChecks,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "./lib/common.mjs";
import { API_PRESETS, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";
import { RpcQaClient } from "./lib/rpc-qa-client.mjs";
import { withTimeout } from "./lib/with-timeout.mjs";

const STEER_MARKER = "SENPI-QA-QUEUED-STEER-42";
const THIRD_REQUEST_MARKER = "SENPI-QA-THIRD-REQUEST-OK-42";
const STREAM_START_TIMEOUT_MS = 1_000;
// Safety bound for the retry continuation only; always far above the start
// watchdog so the watchdog, not this cap, is what kills the hung requests.
const RETRY_WATCHDOG_MS = 15_000;
// Bounded absence window proving no automatic third request admits the steer.
const THIRD_REQUEST_BOUND_MS = 8_000;
const STREAM_START_TIMEOUT_PATTERN = /^Provider stream start timed out after \d+ms$/;

const isStreamStartTimeoutEnd = (event) =>
	event.type === "message_end" &&
	typeof event.message?.errorMessage === "string" &&
	STREAM_START_TIMEOUT_PATTERN.test(event.message.errorMessage);

function userTextOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
	}
	return "";
}

function startServer() {
	const requests = [];
	const hungResponses = new Set();
	const steerRequestWaiters = new Set();
	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			let parsed = null;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = null;
			}
			const userTexts = Array.isArray(parsed?.messages)
				? parsed.messages.filter((message) => message?.role === "user").map((message) => userTextOf(message.content))
				: [];
			const hasSteer = body.includes(STEER_MARKER);
			const entry = {
				attempt: requests.length + 1,
				url: request.url,
				model: parsed?.model ?? "unknown",
				userTexts,
				hasSteer,
				outcome: requests.length < 2 ? "hung-headers-no-sse-event" : "completed",
			};
			requests.push(entry);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			if (requests.length <= 2) {
				// Stream-start watchdog fodder: headers on the wire, never an event.
				response.flushHeaders();
				hungResponses.add(response);
				response.once("close", () => hungResponses.delete(response));
				return;
			}
			if (hasSteer) {
				for (const waiter of steerRequestWaiters) waiter(entry);
				steerRequestWaiters.clear();
			}
			const base = {
				id: "chatcmpl-stream-start-timeout-steering",
				object: "chat.completion.chunk",
				created: 0,
				model: API_PRESETS["openai-completions"].modelId,
			};
			const send = (delta, finishReason = null) => {
				response.write(
					`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
				);
			};
			send({ role: "assistant", content: "" });
			send({ content: hasSteer ? THIRD_REQUEST_MARKER : "SENPI-QA-STEER-MISSING" });
			send({}, "stop");
			response.end("data: [DONE]\n\n");
		});
	});
	return new Promise((resolveServer, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Failed to resolve fake server port"));
				return;
			}
			resolveServer({
				url: `http://127.0.0.1:${address.port}/v1`,
				port: address.port,
				requests,
				waitForSteerRequest: () =>
					new Promise((resolveSteerRequest) => {
						steerRequestWaiters.add(resolveSteerRequest);
					}),
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

function portIsClosed(port) {
	return new Promise((resolveClosed) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolveClosed(false);
		}, 500);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolveClosed(false);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolveClosed(true);
		});
	});
}

async function main() {
	installCleanupHooks();
	const checks = createChecks("mock-loop-stream-start-timeout-steering.mjs");
	const guard = guardRealAuth();
	const box = makeSandbox("mock-loop-stream-start-timeout-steering");
	const server = await startServer();
	const evidenceFlagIndex = process.argv.indexOf("--evidence-dir");
	const evidenceFlag = evidenceFlagIndex !== -1 ? process.argv[evidenceFlagIndex + 1] : undefined;
	const evidencePath = evidenceFlag
		? isAbsolute(evidenceFlag)
			? evidenceFlag
			: resolve(repoRoot(), evidenceFlag)
		: join(repoRoot(), "local-ignore", "qa-evidence", "20260817-retry-exhausted-queued-steering");
	mkdirSync(evidencePath, { recursive: true });
	let client;
	let summary = { pass: false };
	try {
		const preset = API_PRESETS["openai-completions"];
		writeMockModelsJson(box.agentDir, server, "openai-completions");
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify({
				// Idle guard off so the stream-start watchdog is the only bound that
				// can kill the headers-only requests.
				httpIdleTimeoutMs: 0,
				retry: {
					enabled: true,
					// One retry: first timeout retries, second timeout exhausts.
					maxRetries: 1,
					baseDelayMs: 1,
					provider: {
						// Adapter-level retries off: the session retry owns every request.
						maxRetries: 0,
						maxRetryDelayMs: 60_000,
						streamRetryTimeoutMs: RETRY_WATCHDOG_MS,
						streamStartTimeoutMs: STREAM_START_TIMEOUT_MS,
					},
				},
			}),
		);
		client = new RpcQaClient({
			env: hermeticEnv(box.env),
			cwd: box.cwd,
			extraArgs: ["--provider", preset.provider, "--model", preset.modelId, "--no-extensions"],
		});
		// Readiness probe: a cold tsx boot can exceed the default response
		// timeout, so the first handshake gets a wider bound.
		await client.send({ type: "get_state" }, 60_000);
		const baseIndex = client.events.length;
		let promptsSent = 0;
		promptsSent += 1;
		const promptAck = await client.send({ type: "prompt", message: "trigger two provider stream-start watchdog timeouts" });
		const firstTimeout = await client.waitForEvent(isStreamStartTimeoutEnd, baseIndex);
		const retryStart = await client.waitForEvent((event) => event.type === "auto_retry_start", baseIndex);
		const steerIndex = client.events.length;
		const thirdRequestPromise = server.waitForSteerRequest();
		const steerAck = await client.send({ type: "steer", message: STEER_MARKER });
		const queuedSteer = await client.waitForEvent(
			(event) =>
				event.type === "queue_update" && Array.isArray(event.steering) && event.steering.includes(STEER_MARKER),
			steerIndex,
		);
		const afterFirstTimeout = Math.max(0, client.events.indexOf(firstTimeout)) + 1;
		const secondTimeout = await client.waitForEvent(isStreamStartTimeoutEnd, afterFirstTimeout);
		let thirdRequest = null;
		try {
			thirdRequest = await withTimeout(
				thirdRequestPromise,
				"automatic third request carrying the queued steer",
				THIRD_REQUEST_BOUND_MS,
			);
		} catch {
			thirdRequest = null;
		}
		const settled = await client.waitForEvent((event) => event.type === "agent_settled", steerIndex);
		const lastText = await client.send({ type: "get_last_assistant_text" });
		const finalText = typeof lastText.data?.text === "string" ? lastText.data.text : "";
		const markerCount = finalText.split(THIRD_REQUEST_MARKER).length - 1;
		const streamStartTimeouts = client.events.filter(isStreamStartTimeoutEnd);
		const autoRetryStarts = client.events.filter((event) => event.type === "auto_retry_start");
		const twoRealTimeouts =
			promptAck.success === true &&
			streamStartTimeouts.length === 2 &&
			firstTimeout !== undefined &&
			secondTimeout !== undefined &&
			autoRetryStarts.length === 1 &&
			autoRetryStarts[0]?.attempt === 1 &&
			typeof autoRetryStarts[0]?.errorMessage === "string" &&
			STREAM_START_TIMEOUT_PATTERN.test(autoRetryStarts[0].errorMessage);
		checks.ok(
			"two real stream-start watchdog timeouts precede exactly one automatic retry",
			twoRealTimeouts,
			`timeouts=${streamStartTimeouts.length} autoRetryStarts=${autoRetryStarts.length} attempt=${autoRetryStarts[0]?.attempt ?? "none"} error=${autoRetryStarts[0]?.errorMessage ?? "none"}`,
		);
		const steerQueued =
			steerAck.success === true &&
			Array.isArray(queuedSteer?.steering) &&
			queuedSteer.steering.includes(STEER_MARKER);
		checks.ok(
			"RPC steer is acknowledged and queued during the retry window",
			steerQueued,
			`ack=${steerAck.success === true} queued=${Array.isArray(queuedSteer?.steering) && queuedSteer.steering.includes(STEER_MARKER)}`,
		);
		const thirdRequestOk =
			thirdRequest !== null &&
			thirdRequest.hasSteer === true &&
			server.requests.length === 3 &&
			promptsSent === 1 &&
			markerCount === 1 &&
			settled.type === "agent_settled";
		checks.ok(
			"automatic third request carries the queued steer and returns the marker once with no second prompt",
			thirdRequestOk,
			`requests=${server.requests.length} thirdHasSteer=${thirdRequest?.hasSteer ?? "none"} marker=${markerCount} prompts=${promptsSent}`,
		);
		summary = {
			pass: twoRealTimeouts && steerQueued && thirdRequestOk,
			twoRealTimeouts,
			steerQueued,
			thirdRequestOk,
			markerCount,
			promptsSent,
			retryStart: autoRetryStarts[0] ?? null,
			thirdRequest: thirdRequest ?? null,
			requests: server.requests,
			events: client.events,
		};
	} catch (error) {
		summary = {
			...summary,
			error: error instanceof Error ? error.message : String(error),
			requests: server.requests,
			events: client?.events ?? [],
		};
		throw error;
	} finally {
		client?.close();
		let exitCode = null;
		if (client) {
			try {
				exitCode = await client.waitForExit();
			} catch {
				client.kill();
				exitCode = await client.waitForExit();
			}
		}
		await server.stop();
		const closed = await portIsClosed(server.port);
		box.cleanup();
		const sandboxRemoved = !existsSync(box.dir);
		let authUnchanged = false;
		let authGuardError;
		try {
			authUnchanged = guard.assertUnchanged();
		} catch (error) {
			authGuardError = error instanceof Error ? error.message : String(error);
		}
		const cleanupPassed = exitCode === 0 && closed && sandboxRemoved && authUnchanged;
		summary = {
			...summary,
			pass: summary.pass && cleanupPassed,
			cleanup: { exitCode, portClosed: closed, sandboxRemoved, authUnchanged, authGuardError },
		};
		const { events = [], ...summaryWithoutEvents } = summary;
		writeFileSync(join(evidencePath, "rpc-events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"));
		writeFileSync(join(evidencePath, "request-ledger.json"), `${JSON.stringify(summary.requests ?? [], null, 2)}\n`);
		writeFileSync(join(evidencePath, "rpc-stderr.txt"), client?.stderr ?? "");
		writeFileSync(join(evidencePath, "rpc-summary.json"), `${JSON.stringify(summaryWithoutEvents, null, 2)}\n`);
		checks.ok(
			"RPC process, fake server port, sandbox, and auth state are clean",
			cleanupPassed,
			`exit=${exitCode} portClosed=${closed} sandboxRemoved=${sandboxRemoved} authUnchanged=${authUnchanged}`,
		);
	}
	process.exitCode = checks.finish() ? 0 : 1;
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
