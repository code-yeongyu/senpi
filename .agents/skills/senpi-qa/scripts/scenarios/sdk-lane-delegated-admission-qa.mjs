#!/usr/bin/env node
/**
 * Real-CLI QA for delegated pre-prompt compaction admission.
 *
 * Turn 1 accumulates real transcript content through distinct bash file reads.
 * Intermediate tool-call responses report low usage so the tool loop can grow;
 * the final response reports usage matching the resulting transcript band.
 * Turn 2 resumes with --continue and proves the external-owner cancellation is
 * admitted only by the fixed branch.
 */

import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "../lib/common.mjs";
import { checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "../lib/mock-loop-support.mjs";

const CONTEXT_WINDOW = 200_000;
const RESERVE_TOKENS = 75_000;
const ADMISSION_THRESHOLD = CONTEXT_WINDOW - RESERVE_TOKENS;
const PROACTIVE_RATIO = 0.65;
const PROACTIVE_THRESHOLD = CONTEXT_WINDOW * PROACTIVE_RATIO;
const REPORTED_BAND_USAGE = 127_000;
const PAYLOAD_COUNT = 10;
const PAYLOAD_BYTES = 220_000;
const TURN_ONE_MARKER = "SENPI-QA-DELEGATED-TURN-ONE-91f4";
const FINAL_MARKER = "SENPI-QA-DELEGATED-ADMISSION-FINAL-91f4";
const REQUIRED_COMPACTION_ERROR = "Context remains above the compaction threshold because compaction did not complete";

function assertInvariant(condition, message) {
	if (!condition) throw new Error(message);
}

function findFiles(root) {
	const files = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (statSync(path).isDirectory()) files.push(...findFiles(path));
		else files.push(path);
	}
	return files;
}

function payloadText(index) {
	const lines = [];
	let bytes = 0;
	for (let line = 0; bytes < PAYLOAD_BYTES; line++) {
		const text = `PAYLOAD-${String(index).padStart(2, "0")}-${String(line).padStart(6, "0")}-${(index * 104729 + line * 15485863).toString(16).padStart(12, "0")}-${"abcdefghijklmnopqrstuvwxyz0123456789".repeat(2)}\n`;
		lines.push(text);
		bytes += Buffer.byteLength(text);
	}
	return lines.join("").slice(0, PAYLOAD_BYTES);
}

function contentChars(value) {
	if (typeof value === "string") return value.length;
	if (!Array.isArray(value)) return 0;
	return value.reduce((sum, block) => {
		if (!block || typeof block !== "object") return sum;
		if (typeof block.text === "string") return sum + block.text.length;
		if (typeof block.content === "string") return sum + block.content.length;
		if (Array.isArray(block.content)) return sum + contentChars(block.content);
		return sum;
	}, 0);
}

function measureMessages(messages) {
	const list = Array.isArray(messages) ? messages : [];
	const messageContentChars = list.reduce((sum, message) => sum + contentChars(message?.content), 0);
	const toolResultCount = list.reduce((count, message) => {
		const blocks = Array.isArray(message?.content) ? message.content : [];
		return count + blocks.filter((block) => block?.type === "tool_result").length;
	}, 0);
	return {
		messageCount: list.length,
		messageContentChars,
		messageContentTokens: Math.ceil(messageContentChars / 4),
		toolResultCount,
	};
}

function writeAnthropicSse(res, { modelId, inputTokens, text, toolCall, callIndex }) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
	event("message_start", {
		message: {
			id: `msg_sdk_lane_qa_${callIndex}`,
			type: "message",
			role: "assistant",
			model: modelId,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: inputTokens, output_tokens: 0 },
		},
	});
	let contentIndex = 0;
	if (text) {
		event("content_block_start", { index: contentIndex, content_block: { type: "text", text: "" } });
		event("content_block_delta", { index: contentIndex, delta: { type: "text_delta", text } });
		event("content_block_stop", { index: contentIndex });
		contentIndex++;
	}
	if (toolCall) {
		event("content_block_start", {
			index: contentIndex,
			content_block: { type: "tool_use", id: `toolu_sdk_lane_qa_${callIndex}`, name: toolCall.name, input: {} },
		});
		event("content_block_delta", {
			index: contentIndex,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(toolCall.args) },
		});
		event("content_block_stop", { index: contentIndex });
	}
	event("message_delta", {
		delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null },
		usage: { output_tokens: text ? Math.ceil(text.length / 4) : 1 },
	});
	event("message_stop", {});
	res.end();
}

function startBandServer(payloadPaths) {
	const requests = [];
	let callIndex = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {}
			const messageMeasurement = measureMessages(body.messages);
			const reportedInputTokens = callIndex < PAYLOAD_COUNT ? 1 : REPORTED_BAND_USAGE;
			requests.push({
				index: callIndex,
				url: req.url,
				rawBytes: Buffer.byteLength(raw),
				rawTokensAtFourChars: Math.ceil(raw.length / 4),
				...messageMeasurement,
				reportedInputTokens,
			});
			const modelId = body.model ?? "mock-claude";
			if (callIndex < PAYLOAD_COUNT) {
				writeAnthropicSse(res, {
					modelId,
					inputTokens: 1,
					toolCall: { name: "bash", args: { command: `cat ${JSON.stringify(payloadPaths[callIndex])}` } },
					callIndex,
				});
			} else if (callIndex === PAYLOAD_COUNT) {
				writeAnthropicSse(res, {
					modelId,
					inputTokens: REPORTED_BAND_USAGE,
					text: TURN_ONE_MARKER,
					callIndex,
				});
			} else {
				writeAnthropicSse(res, {
					modelId,
					inputTokens: REPORTED_BAND_USAGE,
					text: FINAL_MARKER,
					callIndex,
				});
			}
			callIndex++;
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = server.address().port;
			resolve({
				origin: `http://127.0.0.1:${port}`,
				url: `http://127.0.0.1:${port}/v1`,
				requests,
				stop: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

function writeCancelExtension(extensionPath, probePath) {
	writeFileSync(
		extensionPath,
		`import { appendFileSync } from "node:fs";\n\nconst record = (value) => appendFileSync(${JSON.stringify(probePath)}, JSON.stringify(value) + "\\n");\n\nexport default function delegatedCompactionProbe(pi) {\n\trecord({ event: "loaded" });\n\tpi.on("session_start", (_event, ctx) => record({ event: "session_start", usage: ctx.getContextUsage(), compaction: ctx.getCompactionSettings() }));\n\tpi.on("session_before_compact", (event) => {\n\t\trecord({ event: "session_before_compact", reason: event.reason, requestId: event.requestId, tokensBefore: event.preparation.tokensBefore });\n\t\treturn { cancel: true, rejectionCause: "external-owner", reason: "the Claude Agent SDK owns compaction for this session" };\n\t});\n}\n`,
	);
}

async function main() {
	installCleanupHooks();
	const authGuard = guardRealAuth();
	const box = makeSandbox("sdk-lane-delegated-admission");
	const extensionPath = join(box.dir, "delegated-compaction-probe.mjs");
	const probePath = join(box.dir, "delegated-compaction-probe.jsonl");
	const payloadPaths = Array.from({ length: PAYLOAD_COUNT }, (_, index) => {
		const path = join(box.cwd, `payload-${String(index + 1).padStart(2, "0")}.txt`);
		writeFileSync(path, payloadText(index + 1));
		return path;
	});
	writeCancelExtension(extensionPath, probePath);

	let server;
	let exitCode = 2;
	try {
		server = await startBandServer(payloadPaths);
		writeMockModelsJson(box.agentDir, server, "anthropic-messages", {
			contextWindow: CONTEXT_WINDOW,
			maxTokens: 4_096,
		});
		writeFileSync(
			join(box.agentDir, "settings.json"),
			JSON.stringify(
				{
					disabledBuiltinExtensions: ["compaction"],
					compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
				},
				null,
				2,
			),
		);

		const commonArgs = [
			"--provider", "anthropic",
			"--model", "mock-claude",
			"--no-context-files",
			"--no-extensions",
			"--approve",
			"-e", extensionPath,
		];
		const env = hermeticEnv(box.env);
		const turnOne = await runCli(
			[...commonArgs, "--print", `Read all ${PAYLOAD_COUNT} distinct payload files with bash, one at a time, then finish turn one.`],
			{ env, cwd: box.cwd, timeoutMs: 180_000 },
		);
		const expectedTurnOneRequests = PAYLOAD_COUNT + 1;
		assertInvariant(
			turnOne.code === 0 && turnOne.stdout.includes(TURN_ONE_MARKER),
			`turn 1 failed: code=${turnOne.code} stdout=${turnOne.stdout} stderr=${turnOne.stderr}`,
		);
		assertInvariant(
			server.requests.length === expectedTurnOneRequests,
			`turn 1 expected ${expectedTurnOneRequests} requests, got ${server.requests.length}: ${JSON.stringify(server.requests)}`,
		);
		const turnOneFinalRequest = server.requests.at(-1);
		assertInvariant(turnOneFinalRequest.toolResultCount === PAYLOAD_COUNT, `missing tool results: ${JSON.stringify(turnOneFinalRequest)}`);
		assertInvariant(
			turnOneFinalRequest.messageContentTokens >= ADMISSION_THRESHOLD &&
				turnOneFinalRequest.messageContentTokens < PROACTIVE_THRESHOLD,
			`real content outside band: ${JSON.stringify(turnOneFinalRequest)}`,
		);
		assertInvariant(REPORTED_BAND_USAGE > ADMISSION_THRESHOLD, "reported usage must exceed admission threshold");
		assertInvariant(REPORTED_BAND_USAGE < PROACTIVE_THRESHOLD, "reported usage must stay below proactive threshold");

		const sessionFiles = findFiles(box.sessionDir);
		const persistedSession = sessionFiles.map((path) => readFileSync(path, "utf8")).join("\n");
		assertInvariant(
			persistedSession.includes(`\"input\":${REPORTED_BAND_USAGE}`),
			`turn 1 usage ${REPORTED_BAND_USAGE} was not persisted`,
		);

		const requestCountBeforeTurnTwo = server.requests.length;
		const turnTwo = await runCli([...commonArgs, "--continue", "--print", "say more"], {
			env,
			cwd: box.cwd,
			timeoutMs: 120_000,
		});
		const probeRecords = existsSync(probePath)
			? readFileSync(probePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
			: [];
		const cancelRecords = probeRecords.filter((record) => record.event === "session_before_compact");
		const prePromptCancel = cancelRecords.find((record) => record.reason === "pre_prompt");
		assertInvariant(prePromptCancel, `pre_prompt cancel probe never fired: ${JSON.stringify(probeRecords)}`);
		assertInvariant(turnTwo.code === 0 || turnTwo.code === 1, `unexpected turn 2 exit code ${turnTwo.code}`);
		const turnTwoReachedProvider = server.requests.length === requestCountBeforeTurnTwo + 1;
		if (turnTwo.code === 0) {
			assertInvariant(turnTwo.stdout.includes(FINAL_MARKER), "GREEN arm exited 0 without final marker");
			assertInvariant(turnTwoReachedProvider, `GREEN arm did not reach provider: requests=${server.requests.length}`);
		} else {
			assertInvariant(turnTwo.stderr.includes(REQUIRED_COMPACTION_ERROR), "RED arm lacked RequiredCompactionError stderr");
			assertInvariant(!turnTwo.stdout.includes(FINAL_MARKER), "RED arm unexpectedly printed final marker");
			assertInvariant(!turnTwoReachedProvider, `RED arm unexpectedly reached provider: requests=${server.requests.length}`);
		}

		const summary = {
			scenario: "sdk-lane-delegated-admission-qa",
			window: CONTEXT_WINDOW,
			reserveTokens: RESERVE_TOKENS,
			admissionThreshold: ADMISSION_THRESHOLD,
			proactiveRatio: PROACTIVE_RATIO,
			proactiveThreshold: PROACTIVE_THRESHOLD,
			reportedBandUsage: REPORTED_BAND_USAGE,
			payloadCount: PAYLOAD_COUNT,
			payloadBytesEach: PAYLOAD_BYTES,
			requests: server.requests,
			turnOne: { code: turnOne.code, stdout: turnOne.stdout, stderr: turnOne.stderr },
			turnTwo: { code: turnTwo.code, stdout: turnTwo.stdout, stderr: turnTwo.stderr, reachedProvider: turnTwoReachedProvider },
			probeTimeline: probeRecords,
			realAuthUnchanged: authGuard.assertUnchanged(),
		};
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		if (turnTwo.stderr) process.stderr.write(turnTwo.stderr);
		exitCode = turnTwo.code;
	} finally {
		if (server) await server.stop();
		box.cleanup();
		checkRealAuthUnchanged({ ok: (_name, pass) => assertInvariant(pass, "real auth changed") }, authGuard);
	}
	process.exit(exitCode);
}

await main();
