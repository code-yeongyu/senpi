#!/usr/bin/env node
/**
 * Real-CLI QA for issue #886: an admission compaction aborted by a superseding
 * compaction claim must not wedge the prompt with RequiredCompactionError or
 * surface "Request was aborted" extension errors.
 *
 * Turn 1 grows a real over-threshold session (10 distinct payload reads) whose
 * final usage lands inside the admission band (over window - reserveTokens,
 * under the proactive threshold). Turn 2 resumes with --continue; a sandbox
 * extension supersedes the pre-prompt admission compaction from inside
 * session_before_compact via ctx.beginCompaction (the same claim the builtin
 * blocking route performs), aborting the in-flight attempt. The fixed build
 * admits the prompt quietly, completes the next compaction attempt, reaches
 * the provider, and prints the final marker with a clean stderr; the unfixed
 * build exits 1 with RequiredCompactionError on stderr.
 *
 * Usage:
 *   node .agents/skills/senpi-qa/scripts/scenarios/compaction-abort-standdown-qa.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const TURN_ONE_MARKER = "SENPI-QA-ABORT-STANDDOWN-TURN-ONE-886a";
const FINAL_MARKER = "SENPI-QA-ABORT-STANDDOWN-FINAL-886a";
const SUMMARY_MARKER = "SENPI-QA-ABORT-STANDDOWN-SUMMARY-886a";
const REQUIRED_COMPACTION_ERROR = "Context remains above the compaction threshold because compaction did not complete";
const ABORT_LEAK = "Request was aborted";
const SUMMARY_MARKERS = [
	"[INTERNAL COMPACTION INSTRUCTION",
	"[INTERNAL COMPACTION UPDATE INSTRUCTION",
	"[INTERNAL TURN-PREFIX SUMMARY INSTRUCTION",
	"[INTERNAL BRANCH SUMMARY INSTRUCTION",
];

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

function bodyText(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	return messages
		.map((message) => {
			if (typeof message?.content === "string") return message.content;
			if (!Array.isArray(message?.content)) return "";
			return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
		})
		.join("\n");
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
			id: `msg_abort_standdown_qa_${callIndex}`,
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
			content_block: { type: "tool_use", id: `toolu_abort_standdown_${callIndex}`, name: toolCall.name, input: {} },
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
	let turnCallIndex = 0;
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			let body = {};
			try {
				body = raw ? JSON.parse(raw) : {};
			} catch {}
			const modelId = body.model ?? "mock-claude";
			const text = bodyText(body);
			const isSummarization = SUMMARY_MARKERS.some((marker) => text.includes(marker));
			requests.push({ index: requests.length, kind: isSummarization ? "summarization" : "turn" });
			if (isSummarization) {
				writeAnthropicSse(res, {
					modelId,
					inputTokens: 500,
					text: `${SUMMARY_MARKER}: the earlier payload reads are summarized.`,
					callIndex: requests.length,
				});
				return;
			}
			if (turnCallIndex < PAYLOAD_COUNT) {
				writeAnthropicSse(res, {
					modelId,
					inputTokens: 1,
					toolCall: { name: "bash", args: { command: `cat ${JSON.stringify(payloadPaths[turnCallIndex])}` } },
					callIndex: requests.length,
				});
			} else if (turnCallIndex === PAYLOAD_COUNT) {
				writeAnthropicSse(res, {
					modelId,
					inputTokens: REPORTED_BAND_USAGE,
					text: TURN_ONE_MARKER,
					callIndex: requests.length,
				});
			} else {
				writeAnthropicSse(res, {
					modelId,
					inputTokens: 2_000,
					text: FINAL_MARKER,
					callIndex: requests.length,
				});
			}
			turnCallIndex++;
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

function writeSupersedeExtension(extensionPath, probePath) {
	writeFileSync(
		extensionPath,
		`import { appendFileSync } from "node:fs";\n\nconst record = (value) => appendFileSync(${JSON.stringify(probePath)}, JSON.stringify(value) + "\\n");\nlet attempt = 0;\n\nexport default function abortStanddownProbe(pi) {\n\trecord({ event: "loaded" });\n\tpi.on("session_before_compact", async (event, ctx) => {\n\t\tattempt += 1;\n\t\trecord({ event: "session_before_compact", attempt, reason: event.reason, aborted: event.signal.aborted });\n\t\tif (attempt > 1) return undefined;\n\t\tconst aborted = new Promise((resolve) => {\n\t\t\tevent.signal.addEventListener("abort", () => resolve(), { once: true });\n\t\t});\n\t\tctx.beginCompaction?.({ reason: "extension" });\n\t\tawait aborted;\n\t\trecord({ event: "superseded", attempt });\n\t\treturn undefined;\n\t});\n}\n`,
	);
}

async function main() {
	installCleanupHooks();
	const authGuard = guardRealAuth();
	const box = makeSandbox("compaction-abort-standdown");
	const extensionPath = join(box.dir, "abort-standdown-probe.mjs");
	const probePath = join(box.dir, "abort-standdown-probe.jsonl");
	const payloadPaths = Array.from({ length: PAYLOAD_COUNT }, (_, index) => {
		const path = join(box.cwd, `payload-${String(index + 1).padStart(2, "0")}.txt`);
		writeFileSync(path, payloadText(index + 1));
		return path;
	});
	writeSupersedeExtension(extensionPath, probePath);

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
		assertInvariant(
			turnOne.code === 0 && turnOne.stdout.includes(TURN_ONE_MARKER),
			`turn 1 failed: code=${turnOne.code} stdout=${turnOne.stdout} stderr=${turnOne.stderr}`,
		);
		const sessionFiles = findFiles(box.sessionDir);
		const persistedSession = sessionFiles.map((path) => readFileSync(path, "utf8")).join("\n");
		assertInvariant(
			persistedSession.includes(`\"input\":${REPORTED_BAND_USAGE}`),
			`turn 1 usage ${REPORTED_BAND_USAGE} was not persisted`,
		);
		assertInvariant(REPORTED_BAND_USAGE > ADMISSION_THRESHOLD, "reported usage must exceed admission threshold");
		assertInvariant(REPORTED_BAND_USAGE < PROACTIVE_THRESHOLD, "reported usage must stay below proactive threshold");

		const turnTwo = await runCli([...commonArgs, "--continue", "--print", "say more"], {
			env,
			cwd: box.cwd,
			timeoutMs: 120_000,
		});
		const probeRecords = existsSync(probePath)
			? readFileSync(probePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
			: [];
		const superseded = probeRecords.find((record) => record.event === "superseded");
		assertInvariant(superseded, `supersession probe never fired: ${JSON.stringify(probeRecords)}`);
		assertInvariant(turnTwo.code === 0 || turnTwo.code === 1, `unexpected turn 2 exit code ${turnTwo.code}`);
		if (turnTwo.code === 0) {
			assertInvariant(turnTwo.stdout.includes(FINAL_MARKER), "GREEN arm exited 0 without final marker");
			assertInvariant(!turnTwo.stderr.includes(REQUIRED_COMPACTION_ERROR), "GREEN arm leaked RequiredCompactionError");
			assertInvariant(!turnTwo.stderr.includes(ABORT_LEAK), "GREEN arm leaked 'Request was aborted'");
		} else {
			assertInvariant(turnTwo.stderr.includes(REQUIRED_COMPACTION_ERROR), "RED arm lacked RequiredCompactionError stderr");
			assertInvariant(!turnTwo.stdout.includes(FINAL_MARKER), "RED arm unexpectedly printed final marker");
		}

		const summary = {
			scenario: "compaction-abort-standdown-qa",
			issue: 886,
			window: CONTEXT_WINDOW,
			reserveTokens: RESERVE_TOKENS,
			admissionThreshold: ADMISSION_THRESHOLD,
			proactiveThreshold: PROACTIVE_THRESHOLD,
			reportedBandUsage: REPORTED_BAND_USAGE,
			requests: server.requests,
			turnOne: { code: turnOne.code, stdoutTail: turnOne.stdout.slice(-400) },
			turnTwo: {
				code: turnTwo.code,
				stdoutTail: turnTwo.stdout.slice(-400),
				stderrTail: turnTwo.stderr.slice(-1200),
			},
			probeTimeline: probeRecords,
			realAuthUnchanged: authGuard.assertUnchanged(),
		};
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		exitCode = turnTwo.code;
	} finally {
		if (server) await server.stop();
		box.cleanup();
		checkRealAuthUnchanged({ ok: (_name, pass) => assertInvariant(pass, "real auth changed") }, authGuard);
	}
	process.exit(exitCode);
}

await main();
