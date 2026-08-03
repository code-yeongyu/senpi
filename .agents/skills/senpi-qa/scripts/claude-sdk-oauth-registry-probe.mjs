#!/usr/bin/env node
/**
 * Hermetic real-surface QA for the claude-sdk-oauth resident session registry.
 *
 * Run with:
 *   node .agents/skills/senpi-qa/scripts/claude-sdk-oauth-registry-probe.mjs
 *
 * The outer process re-execs under tsx so this JavaScript probe can import the
 * live TypeScript implementation. The inner process drives the registry APIs
 * against the real Claude Agent SDK / Claude Code subprocess and measures the
 * subprocess's Anthropic requests at a loopback-only SSE server.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
	track,
} from "./lib/common.mjs";
import { safeDetail } from "./lib/output-safety.mjs";
import { withTimeout } from "./lib/with-timeout.mjs";

const ROOT = repoRoot();
const INNER_FLAG = "SENPI_CLAUDE_SDK_REGISTRY_PROBE_INNER";

if (process.env[INNER_FLAG] !== "1") {
	const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename], {
		cwd: ROOT,
		env: { ...process.env, [INNER_FLAG]: "1" },
		stdio: "inherit",
	});
	if (child.error) {
		process.stderr.write(`probe launcher failed: ${child.error.message}\n`);
		process.exit(1);
	}
	process.exit(child.status ?? 1);
}

installCleanupHooks();

const IMPLEMENTATION_DIR = join(
	ROOT,
	"packages",
	"coding-agent",
	"src",
	"core",
	"extensions",
	"builtin",
	"claude-sdk-oauth",
);
const importImplementation = (file) => import(pathToFileURL(join(IMPLEMENTATION_DIR, file)).href);

const [{ ClaudeSdkOauthSessionRegistry }, { submitSessionTurn }, sync] = await Promise.all([
	importImplementation("session-registry.ts"),
	importImplementation("session-registry-pump.ts"),
	importImplementation("session-sync.ts"),
]);

const FIRST_TOKEN = "REGISTRY_FIRST_7f7e6ce9";
const SECOND_TOKEN = "REGISTRY_DELTA_4b0e16ad";
const SYSTEM_IDENTITY_TOKEN = "SENPI_COMPOSED_PROMPT_2d945a91";
const SYSTEM_LANGUAGE_INSTRUCTION = "Always respond in Korean.";
const BOUNDARY_SENTINEL = "SYSTEM_PROMPT_DYNAMIC_BOUNDARY";
const SDK_PREPEND = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const SENPI_SYSTEM_PROMPT = [
	"You are senpi, a coding agent.",
	SYSTEM_IDENTITY_TOKEN,
	SYSTEM_LANGUAGE_INSTRUCTION,
	"Treat each submitted user turn as native message content, not a transcript to continue.",
].join("\n");

function sseResponse(text, sequence) {
	const id = `msg_registry_probe_${sequence}`;
	const events = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id,
					type: "message",
					role: "assistant",
					model: "claude-sonnet-4-5",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 7, output_tokens: 1 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 2 },
			},
		],
		["message_stop", { type: "message_stop" }],
	];
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		})
		.join("");
}

function requestUserTexts(body) {
	if (!Array.isArray(body?.messages)) return [];
	return body.messages
		.filter((message) => message?.role === "user")
		.map((message) => textFromContent(message.content));
}

function systemText(body) {
	if (typeof body?.system === "string") return body.system;
	if (!Array.isArray(body?.system)) return "";
	return body.system.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
}

function hasFabricatedTranscriptLabel(value) {
	return /(^|\n)(?:USER:|ASSISTANT:)(?:\n|$)/.test(value);
}

function outputText(messages) {
	const parts = [];
	for (const message of messages) {
		if (message?.type === "assistant" && Array.isArray(message.message?.content)) {
			parts.push(textFromContent(message.message.content));
		}
		if (message?.type === "result" && typeof message.result === "string") parts.push(message.result);
		if (
			message?.type === "stream_event" &&
			message.event?.type === "content_block_delta" &&
			message.event.delta?.type === "text_delta"
		) {
			parts.push(message.event.delta.text);
		}
	}
	return parts.join("\n");
}

const facts = new Map();
function fact(label, pass, detail) {
	facts.set(label, Boolean(pass));
	process.stdout.write(`[${pass ? "PASS" : "FAIL"}] (${label}) ${safeDetail(detail)}\n`);
}

const authGuard = guardRealAuth();
const box = makeSandbox("claude-sdk-registry-probe");
const registry = new ClaudeSdkOauthSessionRegistry();
const providerRequests = [];
const localControlRequests = [];
const unexpectedRequests = [];
let server;
let entry;
let firstTurn;
let secondTurn;
let secondLookup;
let syncDecision;
let submittedSecondText = "";
let fatalError;

try {
	server = track(
		createServer((request, response) => {
			// Claude Code checks base-URL reachability before sending messages. This
			// request is still loopback-only and carries no model input or auth data.
			if (request.method === "HEAD" && request.url === "/api/hello") {
				localControlRequests.push("HEAD /api/hello");
				response.writeHead(200);
				response.end();
				return;
			}
			if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
				unexpectedRequests.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
				response.writeHead(404, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { type: "probe_unexpected_route", message: "loopback probe route rejected" } }));
				return;
			}

			let raw = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				raw += chunk;
			});
			request.on("end", () => {
				try {
					const parsed = JSON.parse(raw);
					providerRequests.push(parsed);
					const users = requestUserTexts(parsed).join("\n");
					const responseText = users.includes(SECOND_TOKEN) ? "두 번째 응답" : "첫 번째 응답";
					response.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					});
					response.end(sseResponse(responseText, providerRequests.length));
				} catch (error) {
					unexpectedRequests.push(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { type: "probe_invalid_json", message: "invalid JSON" } }));
				}
			});
		}),
	);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
		throw new Error("probe server did not bind exclusively to 127.0.0.1");
	}
	const baseUrl = `http://127.0.0.1:${address.port}`;
	if (!baseUrl.startsWith("http://127.0.0.1:")) throw new Error("refusing non-loopback ANTHROPIC_BASE_URL");

	const subprocessEnv = {
		PATH: process.env.PATH ?? "",
		TMPDIR: box.dir,
		HOME: box.dir,
		USERPROFILE: box.dir,
		CLAUDE_CONFIG_DIR: join(box.dir, "claude-config"),
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: "registry-probe-dummy-key",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_DISABLE_TELEMETRY: "1",
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	};
	const sessionId = `senpi-probe-${randomUUID()}`;
	const options = {
		cwd: box.cwd,
		model: "claude-sonnet-4-5",
		tools: [],
		permissionMode: "dontAsk",
		includePartialMessages: true,
		settingSources: [],
		systemPrompt: SENPI_SYSTEM_PROMPT,
		env: subprocessEnv,
	};
	entry = registry.getOrCreate({
		senpiSessionId: sessionId,
		accountName: "hermetic-dummy-account",
		modelId: "claude-sonnet-4-5",
		toolsetHash: "probe-toolset-v1",
		systemPromptHash: "probe-system-prompt-v1",
		options,
	});
	const firstLookup = registry.getOrCreate({
		senpiSessionId: sessionId,
		accountName: "hermetic-dummy-account",
		modelId: "claude-sonnet-4-5",
		toolsetHash: "probe-toolset-v1",
		systemPromptHash: "probe-system-prompt-v1",
		options,
	});

	const firstMessage = { role: "user", content: [{ type: "text", text: FIRST_TOKEN }] };
	firstTurn = await withTimeout(
		submitSessionTurn(registry, entry, { message: firstMessage }),
		"first registry turn",
		45_000,
	);

	const firstContextMessages = [{ role: "user", content: FIRST_TOKEN }];
	const firstHashes = sync.sentMessageHashes(firstContextMessages);
	sync.recordSyncedStream(entry, firstHashes);

	const secondContextMessages = [
		...firstContextMessages,
		{ role: "assistant", content: [{ type: "text", text: "첫 번째 응답" }] },
		{ role: "user", content: SECOND_TOKEN },
	];
	const sentSecondContext = secondContextMessages.filter(
		(message) => message.role === "user" || message.role === "toolResult",
	);
	const secondHashes = sync.sentMessageHashes(sentSecondContext);
	syncDecision = sync.decideSessionSync({
		entry,
		currentHashes: secondHashes,
		accountName: "hermetic-dummy-account",
		modelId: "claude-sonnet-4-5",
		fingerprint: { toolsetHash: "probe-toolset-v1", systemPromptHash: "probe-system-prompt-v1" },
		tokenExpiring: false,
	});
	if (syncDecision.kind !== "incremental") {
		throw new Error(`expected incremental sync decision, received ${JSON.stringify(syncDecision)}`);
	}
	const secondBlocks = sync.buildDeltaPromptBlocks(sentSecondContext.slice(syncDecision.from));
	submittedSecondText = textFromContent(secondBlocks);
	secondLookup = registry.getOrCreate({
		senpiSessionId: sessionId,
		accountName: "hermetic-dummy-account",
		modelId: "claude-sonnet-4-5",
		toolsetHash: "probe-toolset-v1",
		systemPromptHash: "probe-system-prompt-v1",
		options,
	});
	secondTurn = await withTimeout(
		submitSessionTurn(registry, secondLookup, { message: { role: "user", content: secondBlocks } }),
		"second registry turn",
		45_000,
	);

	const requestWithFirst = providerRequests.find((body) => requestUserTexts(body).some((text) => text.includes(FIRST_TOKEN)));
	const requestWithSecond = providerRequests.find((body) => requestUserTexts(body).some((text) => text.includes(SECOND_TOKEN)));
	const firstIndex = requestWithFirst ? providerRequests.indexOf(requestWithFirst) : -1;
	const secondIndex = requestWithSecond ? providerRequests.indexOf(requestWithSecond) : -1;
	const secondUserTexts = requestWithSecond ? requestUserTexts(requestWithSecond) : [];
	const newestSecondUserText = secondUserTexts.at(-1) ?? "";
	const sameHandle =
		entry === firstLookup &&
		entry === secondLookup &&
		entry.query === firstLookup.query &&
		entry.query === secondLookup.query &&
		entry.sdkSessionId === secondLookup.sdkSessionId &&
		firstIndex >= 0 &&
		secondIndex > firstIndex &&
		providerRequests.length === 2;
	fact(
		"a",
		sameHandle,
		`same registry entry/query/sdk-session identity across both turns; provider requests=${providerRequests.length}`,
	);

	const deltaOnly =
		syncDecision.kind === "incremental" &&
		syncDecision.from === 1 &&
		submittedSecondText === SECOND_TOKEN &&
		newestSecondUserText === SECOND_TOKEN &&
		!newestSecondUserText.includes(FIRST_TOKEN) &&
		secondIndex > firstIndex;
	fact(
		"b",
		deltaOnly,
		`sync=${syncDecision.kind}${syncDecision.kind === "incremental" ? ` from=${syncDecision.from}` : ""}; newest turn-2 user payload is exactly the new delta token`,
	);

	const modelVisibleInput = providerRequests
		.map((body) => `${systemText(body)}\n${requestUserTexts(body).join("\n")}`)
		.join("\n");
	const observedOutput = `${outputText(firstTurn.messages)}\n${outputText(secondTurn.messages)}`;
	const noLabels =
		!hasFabricatedTranscriptLabel(modelVisibleInput) &&
		!hasFabricatedTranscriptLabel(observedOutput) &&
		!hasFabricatedTranscriptLabel(submittedSecondText);
	fact("c", noLabels, "zero line-level fabricated USER:/ASSISTANT: transcript labels in model-visible input or SDK output");

	const receivedSystems = providerRequests.map(systemText);
	const systemPromptIntact =
		receivedSystems.length === 2 &&
		receivedSystems.every(
			(text) =>
				text.includes("You are senpi, a coding agent.") &&
				text.includes(SYSTEM_IDENTITY_TOKEN) &&
				text.includes(SYSTEM_LANGUAGE_INSTRUCTION) &&
				!text.includes(BOUNDARY_SENTINEL),
		);
	fact(
		"d",
		systemPromptIntact,
		`senpi composed prompt identity/language markers arrived intact; ${BOUNDARY_SENTINEL} absent`,
	);
	const cliPrepended = receivedSystems.some((text) => text.includes(SDK_PREPEND));
	process.stdout.write(
		`NOTE: Claude Code CLI ${cliPrepended ? "did" : "did not visibly"} prepend its own SDK agent block; senpi's prompt-intact assertion allows that unconditional CLI-owned prefix.\n`,
	);
	process.stdout.write(
		"ROUTE: registry API (getOrCreate + decideSessionSync + submitSessionTurn), chosen to isolate the frozen resident-registry behavior while still driving the real Claude Code subprocess and measuring its wire requests.\n",
	);
	process.stdout.write(`HERMETIC: loopback control requests=${localControlRequests.length}; model requests=${providerRequests.length}; no ambient provider credentials were passed.\n`);
	if (unexpectedRequests.length > 0) {
		throw new Error(`unexpected loopback request(s): ${unexpectedRequests.join(", ")}`);
	}
} catch (error) {
	fatalError = error instanceof Error ? error : new Error(String(error));
} finally {
	if (entry) {
		try {
			registry.closeSession(entry.senpiSessionId, "probe_complete");
		} catch {}
	}
	if (server) {
		await new Promise((resolve) => server.close(resolve));
	}
	try {
		authGuard.assertUnchanged();
	} catch (error) {
		fatalError = error instanceof Error ? error : new Error(String(error));
	}
	box.cleanup();
}

for (const label of ["a", "b", "c", "d"]) {
	if (!facts.has(label)) fact(label, false, fatalError?.message ?? "probe ended before this fact could be measured");
}
if (fatalError) process.stderr.write(`PROBE ERROR: ${safeDetail(fatalError.stack ?? fatalError.message)}\n`);
const passed = [...facts.values()].every(Boolean) && !fatalError;
process.stdout.write(`VERDICT: ${passed ? "PASS" : "FAIL"} claude-sdk-oauth resident session registry real-surface probe\n`);
process.exit(passed ? 0 : 1);
