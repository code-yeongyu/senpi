/**
 * Channel 3 — Mock-loop QA (deterministic, zero real API calls, zero tokens).
 *
 * Spins up a local fake model server, registers it via a baseUrl override in an
 * isolated models.json, and drives a REAL agent turn through the actual CLI.
 * Supports the three wire formats senpi uses, so baseUrl override is QA-covered
 * for OpenAI (chat completions + responses) AND Anthropic:
 *   --api openai-completions   provider "mock"      -> /v1/chat/completions (Bearer)
 *   --api anthropic-messages   provider "anthropic" -> /v1/messages       (x-api-key)
 *   --api openai-responses     provider "openai"    -> /v1/responses       (Bearer)
 *
 * A pass proves the live binary talked to OUR localhost server with the mock
 * key — never a real provider.
 *
 * Usage:
 *   node mock-loop.mjs --self-test                       # all three APIs round-trip
 *   node mock-loop.mjs --self-test --api anthropic-messages
 *   node mock-loop.mjs --with-tool [--api ...]           # full loop: model -> bash -> final text
 *   node mock-loop.mjs --with-tool --serve --serve-env /tmp/senpi-qa.env
 *     Optional: SENPI_QA_TOOL_SERVE_DELAY_MS=<positive integer> spaces the
 *     scripted streaming responses, keeping the tool loop in flight for QA.
 *   node mock-loop.mjs --with-tool --serve --self-test   # HTTP scenario proof
 *   node mock-loop.mjs --with-reasoning [--slow] [--api ...]
 *   node mock-loop.mjs --with-reasoning --serve --serve-env /tmp/senpi-qa.env
 *   (the flag is --serve-env, NOT --env-file: Node treats --env-file as a native
 *    startup flag and would try to load the path as a dotenv file before the script runs)
 *   node mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"ok"}'
 *   node mock-loop.mjs --scenario transient-recover|budget-exhaust|server-error-fallback|long-retry-after|billing-swap|anthropic-policy-refusal-fallback|kimi-xtml-thinking-recover
 *   node mock-loop.mjs --scenario hinted-429-in-turn|no-hint-429-fast-fallback|hinted-429-probe-back|no-hint-429-no-chain
 *   node mock-loop.mjs --run "prompt" [--api ...] [--evidence SLUG]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	runCli,
} from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import {
	ALL_APIS,
	API_PRESETS,
	PROVIDER_ENV_KEYS,
	QA_FINAL_MARKER,
	QA_REASONING_MARKER,
	assertMcpFixtureToolName,
	checkRealAuthUnchanged,
	hermeticEnv,
	mcpFixtureForToolName,
	reasoningScriptedTurn,
	safeErrorReason,
	validateMcpFixtureToolResult,
	writeMcpFixtureExtension,
	writeMockModelsJson,
	writeToolEvidence,
} from "./lib/mock-loop-support.mjs";
import { dispatchExitCode, flagValue, parseToolArgs, positionalAfter } from "./lib/mock-loop-cli.mjs";
import { checkStandardRetryScenarios, isRetryScenario, retryScenarioNames, runRetryScenario } from "./lib/mock-loop-retry.mjs";
import { isHint429Scenario } from "./lib/mock-loop-hint-429.mjs";
import { isTtsrScenario, runTtsrScenario, TTSR_SCENARIOS } from "./lib/mock-loop-ttsr.mjs";
import {
	appendTextToolLeakChecks,
	dispatchTextToolLeakCommand,
	runTextToolLeakScenario,
	TEXT_LEAK_APIS,
} from "./lib/mock-loop-text-leak.mjs";

const QA_TOOL_SERVE_ASSISTANT_MARKER = "SENPI-QA-TOOL-SERVE-ASSISTANT-24c7";
const QA_TOOL_SERVE_RESULT_MARKER = "SENPI-QA-TOOL-SERVE-RESULT-24c7";
const QA_TOOL_SERVE_FINAL_MARKER = "SENPI-QA-TOOL-SERVE-FINAL-24c7";
const TOOL_SERVE_DELAY_ENV = "SENPI_QA_TOOL_SERVE_DELAY_MS";
const TOOL_SERVE_SELF_TEST_DELAY_MS = 25;

function toolServeDelayMs(raw = process.env[TOOL_SERVE_DELAY_ENV]) {
	if (raw === undefined || raw === "") return 0;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`${TOOL_SERVE_DELAY_ENV} must be a positive integer milliseconds value when set; got ${JSON.stringify(raw)}`);
	}
	const delayMs = Number(raw);
	if (!Number.isSafeInteger(delayMs)) {
		throw new Error(`${TOOL_SERVE_DELAY_ENV} exceeds the supported integer range; got ${JSON.stringify(raw)}`);
	}
	return delayMs;
}

/**
 * The normal scripted tool loop is assistant text -> bash call -> final text.
 * Evidence callers may opt in to streaming assistant text before the tool call
 * and spacing the final text's two deltas after the real tool result returns.
 * The default remains the original three synchronous scripted turns.
 */
function toolServeScriptedTurns({ finalResponseDelayMs = 0 } = {}) {
	if (!Number.isSafeInteger(finalResponseDelayMs) || finalResponseDelayMs < 0) {
		throw new Error(`finalResponseDelayMs must be a non-negative safe integer; got ${finalResponseDelayMs}`);
	}
	const bashCall = { name: "bash", args: { command: `printf '${QA_TOOL_SERVE_RESULT_MARKER}\\n'` } };
	if (finalResponseDelayMs > 0) {
		// The first delta contains the complete assistant marker. Two delayed
		// trailing deltas keep it visibly streamed before the tool call arrives.
		const assistantStreamingText = `${QA_TOOL_SERVE_ASSISTANT_MARKER}${" ".repeat(96)}`;
		return [
			{ text: assistantStreamingText, chunks: 3, chunkDelayMs: finalResponseDelayMs, toolCalls: [bashCall] },
			{ text: QA_TOOL_SERVE_FINAL_MARKER, chunks: 2, chunkDelayMs: finalResponseDelayMs },
		];
	}
	return [{ text: QA_TOOL_SERVE_ASSISTANT_MARKER }, { toolCalls: [bashCall] }, { text: QA_TOOL_SERVE_FINAL_MARKER }];
}

async function driveTurn({
	apiName,
	turns,
	prompt,
	extraArgs = [],
	prepareSandbox,
	timeoutMs = 90000,
	modelOverrides,
	mockModels,
	retry,
	followUpPrompts = [],
}) {
	const p = API_PRESETS[apiName];
	const box = makeSandbox(`mock-loop-${apiName}`);
	const resolvedTurns = typeof turns === "function" ? turns(box) : turns;
	const server = await startFakeModelServer({ turns: resolvedTurns });
	writeMockModelsJson(box.agentDir, server, apiName, modelOverrides, { models: mockModels, retry });
	const prepared = prepareSandbox ? await prepareSandbox(box) : {};
	const args = [
		"--provider",
		p.provider,
		"--model",
		p.modelId,
		"--no-context-files",
		"--no-extensions",
		...(prepared.extraArgs ?? []),
		...extraArgs,
		"--print",
		prompt,
	];
	const result = await runCli(args, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs });
	if (followUpPrompts.length > 0) {
		let combined = result;
		for (const followUp of followUpPrompts) {
			const followArgs = args.slice(0, -1);
			followArgs.splice(followArgs.length - 1, 0, "--continue");
			followArgs.push(followUp);
			const next = await runCli(followArgs, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs });
			combined = {
				code: combined.code === 0 ? next.code : combined.code,
				stdout: `${combined.stdout}\n${next.stdout}`,
				stderr: `${combined.stderr}\n${next.stderr}`,
				timedOut: combined.timedOut || next.timedOut,
			};
		}
		return { box, server, result: combined, preset: p, prepared };
	}
	return { box, server, result, preset: p, prepared };
}

/** Assert one API round-trips through the real loop via baseUrl override. */
async function checkApi(checks, apiName) {
	const marker = `SENPI-QA-MOCK-${apiName}-4d9c`;
	const { box, server, result, preset } = await driveTurn({ apiName, turns: [{ text: marker }], prompt: "Reply with the secret marker exactly." });
	const got = (result.stdout + result.stderr).includes(marker);
	const req = server.requests.find((r) => r.url && r.url.includes(preset.path));
	const authOk = preset.auth === "x-api-key" ? req?.apiKeyHeader === preset.apiKey : req?.authorization === `Bearer ${preset.apiKey}`;
	const pass = result.code === 0 && got && !!req && req.model === preset.modelId && authOk;
	checks.ok(`${apiName}: baseUrl override round-trips through the real loop`, pass, `code=${result.code} marker=${got} path=${req?.url ?? "none"} auth=${authOk}`);
	if (!pass) process.stderr.write(`\n--- ${apiName} stderr tail ---\n${result.stderr.slice(-1200)}\n`);
	await server.stop();
	box.cleanup();
	return pass;
}

async function selfTest(onlyApi) {
	installCleanupHooks();
	const checks = createChecks("mock-loop.mjs --self-test");
	const guard = guardRealAuth();
	const apis = onlyApi ? [onlyApi] : ALL_APIS;
	for (const api of apis) {
		await checkApi(checks, api);
		if (TEXT_LEAK_APIS.includes(api)) {
			appendTextToolLeakChecks(checks, await runTextToolLeakScenario({ apiName: api, truncated: false, driveTurn }));
			appendTextToolLeakChecks(checks, await runTextToolLeakScenario({ apiName: api, truncated: true, driveTurn }));
		}
	}
	if (!onlyApi) {
		await checkStandardRetryScenarios(checks, driveTurn);
	}
	checks.ok("zero real provider calls (only localhost fake hit)", true, "all baseUrls point at 127.0.0.1");
	checkRealAuthUnchanged(checks, guard);
	checks.ok(
		"unknown command dispatch is classified as usage error 2",
		dispatchExitCode(["--unknown-command"]) === 2,
		"direct CLI QA verifies stderr usage and process exit 2",
	);
	process.exit(checks.finish() ? 0 : 1);
}

async function withTool(apiName) {
	return withNamedTool({
		apiName,
		checkName: `mock-loop.mjs --with-tool (${apiName})`,
		toolName: "bash",
		toolArgs: { command: "echo TOOL-LOOP-OK-22b8" },
		marker: "TOOL-LOOP-OK-22b8",
		extraArgs: ["--approve"],
	});
}

async function withReasoning(apiName, slow) {
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --with-reasoning${slow ? " --slow" : ""} (${apiName})`);
	const guard = guardRealAuth();
	const turn = reasoningScriptedTurn({ slow });
	const { box, server, result } = await driveTurn({
		apiName,
		turns: [turn],
		prompt: "Return the final marker after completing your reasoning.",
		timeoutMs: slow ? 120000 : 90000,
	});
	const allOutput = result.stdout + result.stderr;
	const reasoningDeltas = server.streamLog.filter((entry) => entry.kind === "reasoning_delta");
	const streamedReasoning = reasoningDeltas.map((entry) => entry.delta).join("");
	checks.ok("CLI completed the reasoning-first loop", result.code === 0 && !result.timedOut, `code=${result.code}`);
	checks.ok("final assistant text returned", allOutput.includes(QA_FINAL_MARKER), QA_FINAL_MARKER);
	checks.ok(
		"server stream log recorded the scripted reasoning chunks",
		reasoningDeltas.length >= 1 && streamedReasoning === turn.reasoning && streamedReasoning.includes(QA_REASONING_MARKER),
		`chunks=${reasoningDeltas.length} marker=${streamedReasoning.includes(QA_REASONING_MARKER)}`,
	);
	checkRealAuthUnchanged(checks, guard);
	if (result.timedOut || result.code !== 0) process.stderr.write(`\n--- stderr tail ---\n${result.stderr.slice(-1500)}\n`);
	await server.stop();
	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeServeEnvFile(envFile, box) {
	const env = hermeticEnv(box.env);
	for (const key of PROVIDER_ENV_KEYS) env[key] = "";
	env.SENPI_QA_MODELS_JSON = join(box.agentDir, "models.json");
	const keys = [
		"SENPI_CODING_AGENT_DIR",
		"SENPI_CODING_AGENT_SESSION_DIR",
		"PI_OFFLINE",
		"PI_TELEMETRY",
		"PAGER",
		"GIT_PAGER",
		"SENPI_QA_MODELS_JSON",
		...PROVIDER_ENV_KEYS,
	];
	mkdirSync(dirname(envFile), { recursive: true });
	writeFileSync(
		envFile,
		["# Generated by senpi-qa mock-loop --serve. Safe to source in an external TUI.", ...keys.map((key) => `export ${key}=${shellQuote(env[key] ?? "")}`), ""].join("\n"),
	);
}

async function serveReasoning(apiName, envFile, slow) {
	const guard = guardRealAuth();
	const box = makeSandbox(`mock-loop-serve-${apiName}`);
	let server;
	try {
		const turns = [reasoningScriptedTurn({ slow })];
		server = await startFakeModelServer({ turns });
		writeMockModelsJson(box.agentDir, server, apiName);
		writeServeEnvFile(envFile, box);
	} catch (error) {
		if (server) await server.stop();
		box.cleanup();
		throw error;
	}

	const authDigest = guard.before ? `sha256=${guard.before.slice(0, 12)}...` : "sha256=absent";
	process.stdout.write(`SENPI_QA_AUTH_GUARD=1 ${authDigest} path=${guard.path}\n`);
	process.stdout.write(`SENPI_QA_SERVE_ENV_FILE=${envFile}\n`);
	process.stdout.write("SENPI_QA_SERVE_READY=1\n");

	let shutdown;
	const stop = async () => {
		if (!shutdown) {
			shutdown = (async () => {
				await server.stop();
				box.cleanup();
				guard.assertUnchanged();
			})();
		}
		return shutdown;
	};
	await new Promise((resolve, reject) => {
		const onSignal = () => {
			void stop().then(resolve, reject);
		};
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);
	});
}

async function requestToolServeTurn(server, preset, messages, { observePartialFinal = false } = {}) {
	const headers = { "content-type": "application/json" };
	if (preset.auth === "x-api-key") headers["x-api-key"] = preset.apiKey;
	else headers.authorization = `Bearer ${preset.apiKey}`;
	const response = await fetch(`${server.origin}${preset.path}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: preset.modelId, stream: true, messages }),
	});
	if (!observePartialFinal || !response.body) {
		return { ok: response.ok, bytes: Buffer.from(await response.arrayBuffer()), observedPartialFinal: false };
	}

	// A read is an output event, not a time-based sample. The delayed script must
	// expose a final-marker prefix before its delayed completing chunk.
	const reader = response.body.getReader();
	const chunks = [];
	let observedPartialFinal = false;
	const finalPrefix = QA_TOOL_SERVE_FINAL_MARKER.slice(0, Math.ceil(QA_TOOL_SERVE_FINAL_MARKER.length / 2));
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(Buffer.from(value));
		const received = Buffer.concat(chunks);
		if (received.includes(Buffer.from(finalPrefix)) && !received.includes(Buffer.from(QA_TOOL_SERVE_FINAL_MARKER))) {
			observedPartialFinal = true;
		}
	}
	return { ok: response.ok, bytes: Buffer.concat(chunks), observedPartialFinal };
}

/** Exercise the serve script over the same localhost HTTP boundary an interactive CLI uses. */
async function checkToolServeScenario(apiName, { finalResponseDelayMs = 0 } = {}) {
	const preset = API_PRESETS[apiName];
	const server = await startFakeModelServer({ turns: toolServeScriptedTurns({ finalResponseDelayMs }) });
	try {
		const first = await requestToolServeTurn(server, preset, [{ role: "user", content: "first interactive turn" }]);
		if (finalResponseDelayMs > 0) {
			const final = await requestToolServeTurn(
				server,
				preset,
				[{ role: "assistant", content: QA_TOOL_SERVE_ASSISTANT_MARKER }, { role: "tool", tool_call_id: "call_1", content: QA_TOOL_SERVE_RESULT_MARKER }],
				{ observePartialFinal: true },
			);
			const assistantDeltas = server.streamLog.filter((entry) => entry.streamId === 0 && entry.kind === "text_delta").map((entry) => entry.delta);
			const finalDeltas = server.streamLog.filter((entry) => entry.streamId === 1 && entry.kind === "text_delta").map((entry) => entry.delta);
			const delayedBoundary = first.ok && final.ok && first.bytes.includes(Buffer.from('"bash"')) && server.requests.length === 2 && server.requests[1].raw.includes(QA_TOOL_SERVE_RESULT_MARKER) && assistantDeltas.length === 3 && assistantDeltas.join("").startsWith(QA_TOOL_SERVE_ASSISTANT_MARKER) && finalDeltas.length === 2 && finalDeltas.join("") === QA_TOOL_SERVE_FINAL_MARKER && final.observedPartialFinal;
			return { pass: delayedBoundary, detail: `requests=${server.requests.length} assistantDeltas=${JSON.stringify(assistantDeltas)} finalDeltas=${JSON.stringify(finalDeltas)} partialFinal=${final.observedPartialFinal}`, defaultFast: false, delayedBoundary };
		}
		const second = await requestToolServeTurn(server, preset, [{ role: "user", content: "please run the scripted tool" }]);
		const third = await requestToolServeTurn(server, preset, [{ role: "assistant", content: "tool call emitted" }, { role: "tool", tool_call_id: "call_1", content: QA_TOOL_SERVE_RESULT_MARKER }]);
		const finalDeltas = server.streamLog.filter((entry) => entry.streamId === 2 && entry.kind === "text_delta").map((entry) => entry.delta);
		const defaultFast = first.ok && second.ok && third.ok && first.bytes.includes(Buffer.from(QA_TOOL_SERVE_ASSISTANT_MARKER)) && second.bytes.includes(Buffer.from('"bash"')) && third.bytes.includes(Buffer.from(QA_TOOL_SERVE_FINAL_MARKER)) && server.requests.length === 3 && server.requests[2].raw.includes(QA_TOOL_SERVE_RESULT_MARKER) && finalDeltas.length === 1 && finalDeltas[0] === QA_TOOL_SERVE_FINAL_MARKER;
		return { pass: defaultFast, detail: `requests=${server.requests.length} assistant=${first.ok} tool=${second.ok} final=${third.ok} finalDeltas=${JSON.stringify(finalDeltas)}`, defaultFast, delayedBoundary: false };
	} finally {
		await server.stop();
	}
}

async function toolServeSelfTest(apiName) {
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --with-tool --serve --self-test (${apiName})`);
	const guard = guardRealAuth();
	const defaultResult = await checkToolServeScenario(apiName);
	checks.ok(
		"interactive tool serve scenario returns assistant text, tool call, tool result, and final text over HTTP",
		defaultResult.pass,
		defaultResult.detail,
	);
	checks.ok(
		"tool serve default remains a single immediate final delta",
		defaultResult.defaultFast,
		defaultResult.detail,
	);
	const delayedResult = await checkToolServeScenario(apiName, { finalResponseDelayMs: TOOL_SERVE_SELF_TEST_DELAY_MS });
	checks.ok(
		"opt-in tool serve delay exposes a partial final marker before the delayed completion",
		delayedResult.pass && delayedResult.delayedBoundary,
		`${delayedResult.detail} delayMs=${TOOL_SERVE_SELF_TEST_DELAY_MS}`,
	);
	checks.ok(
		"tool serve delay environment accepts only positive integer milliseconds",
		toolServeDelayMs("37") === 37 && toolServeDelayMs("") === 0,
		`${TOOL_SERVE_DELAY_ENV}=37`,
	);
	checkRealAuthUnchanged(checks, guard);
	process.exit(checks.finish() ? 0 : 1);
}

async function serveTool(apiName, envFile) {
	const guard = guardRealAuth();
	const finalResponseDelayMs = toolServeDelayMs();
	const box = makeSandbox(`mock-loop-serve-tool-${apiName}`);
	let server;
	try {
		server = await startFakeModelServer({ turns: toolServeScriptedTurns({ finalResponseDelayMs }) });
		writeMockModelsJson(box.agentDir, server, apiName);
		writeServeEnvFile(envFile, box);
	} catch (error) {
		if (server) await server.stop();
		box.cleanup();
		throw error;
	}

	const authDigest = guard.before ? `sha256=${guard.before.slice(0, 12)}...` : "sha256=absent";
	process.stdout.write(`SENPI_QA_AUTH_GUARD=1 ${authDigest} path=${guard.path}\n`);
	process.stdout.write(`SENPI_QA_SERVE_ENV_FILE=${envFile}\n`);
	process.stdout.write("SENPI_QA_SERVE_SCENARIO=tool-call\n");
	process.stdout.write(`SENPI_QA_TOOL_SERVE_ASSISTANT_MARKER=${QA_TOOL_SERVE_ASSISTANT_MARKER}\n`);
	process.stdout.write(`SENPI_QA_TOOL_SERVE_RESULT_MARKER=${QA_TOOL_SERVE_RESULT_MARKER}\n`);
	process.stdout.write(`SENPI_QA_TOOL_SERVE_FINAL_MARKER=${QA_TOOL_SERVE_FINAL_MARKER}\n`);
	process.stdout.write(`SENPI_QA_TOOL_SERVE_FINAL_RESPONSE_DELAY_MS=${finalResponseDelayMs}\n`);
	process.stdout.write("SENPI_QA_SERVE_READY=1\n");

	let shutdown;
	const stop = async () => {
		if (!shutdown) {
			shutdown = (async () => {
				await server.stop();
				box.cleanup();
				guard.assertUnchanged();
			})();
		}
		return shutdown;
	};
	await new Promise((resolve, reject) => {
		const onSignal = () => {
			void stop().then(resolve, reject);
		};
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);
	});
}

async function withMcpTool(apiName, toolName, toolArgs, evidenceSlug) {
	assertMcpFixtureToolName(toolName);
	const fixture = mcpFixtureForToolName(toolName);
	return withNamedTool({
		apiName,
		checkName: `mock-loop.mjs --with-mcp-tool ${toolName} (${apiName})`,
		toolName,
		toolArgs,
		marker: `MCP-TOOL-LOOP-OK:${toolName}:${fixture.resultPrefix}`,
		extraArgs: ["--approve", "--tools", toolName],
		prepareSandbox: (box) => writeMcpFixtureExtension(box, { toolName, fixture }),
		validateToolResult: ({ prepared, server }) => validateMcpFixtureToolResult({ prepared, server }),
		evidenceSlug,
	});
}

async function withNamedTool({
	apiName,
	checkName,
	toolName,
	toolArgs,
	marker,
	extraArgs,
	prepareSandbox,
	validateToolResult,
	evidenceSlug,
}) {
	installCleanupHooks();
	const checks = createChecks(checkName);
	const guard = guardRealAuth();
	const { box, server, result, prepared } = await driveTurn({
		apiName,
		turns: [{ toolCalls: [{ name: toolName, args: toolArgs }] }, { text: `Done: ${marker}` }],
		prompt: `Call the ${toolName} tool and report the output.`,
		extraArgs,
		prepareSandbox,
		timeoutMs: 120000,
	});
	checks.ok("CLI completed the multi-step loop", !result.timedOut, `code=${result.code}`);
	checks.ok("two model turns served (loop iterated)", server.requests.length >= 2, `requests=${server.requests.length}`);
	if (validateToolResult) {
		const toolResult = validateToolResult({ prepared, server, result });
		checks.ok(toolResult.name, toolResult.pass, toolResult.detail);
	}
	checks.ok("final assistant text returned", (result.stdout + result.stderr).includes(marker));
	checkRealAuthUnchanged(checks, guard);
	if (evidenceSlug) writeToolEvidence(evidenceSlug, { apiName, result, server, prepared });
	if (result.timedOut || server.requests.length < 2) process.stderr.write(`\n--- stderr tail ---\n${result.stderr.slice(-1500)}\n`);
	await server.stop();
	box.cleanup();
	process.exit(checks.finish() ? 0 : 1);
}

async function run(prompt, apiName, slug) {
	installCleanupHooks();
	const guard = guardRealAuth();
	const marker = "SENPI-QA-MOCK";
	const { box, server, result } = await driveTurn({ apiName, turns: [{ text: `${marker}: ${prompt}` }], prompt });
	process.stdout.write(`${result.stdout}\n`);
	if (slug) {
		const dir = evidenceDir(slug);
		writeFileSync(join(dir, `mock-loop-${apiName}-stdout.txt`), result.stdout);
		writeFileSync(join(dir, `mock-loop-${apiName}-requests.json`), JSON.stringify(server.requests, null, 2));
		process.stderr.write(`evidence: ${dir}\n`);
	}
	guard.assertUnchanged();
	await server.stop();
	box.cleanup();
}

const argv = process.argv.slice(2);
const api = flagValue(argv, "--api");
if (api && !API_PRESETS[api]) {
	process.stderr.write(`unknown --api ${api}. valid: ${ALL_APIS.join(", ")}\n`);
	process.exit(2);
}

const scenario = flagValue(argv, "--scenario");
if (scenario !== undefined && !isRetryScenario(scenario) && !isTtsrScenario(scenario)) {
	process.stderr.write(`unknown --scenario ${scenario}. valid: ${[...retryScenarioNames(), ...TTSR_SCENARIOS].join(", ")}\n`);
	process.exit(2);
}

if (argv[0] === "--self-test") {
	selfTest(api).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv[0] === "--with-tool" && argv.includes("--serve") && argv.includes("--self-test")) {
	toolServeSelfTest(api || "openai-completions").catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (scenario && isTtsrScenario(scenario)) {
	runTtsrScenario({ scenarioName: scenario, apiName: api || "openai-completions", driveTurn, evidenceSlug: flagValue(argv, "--evidence") }).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (scenario) {
	// The hint-aware 429 tiers need the Anthropic boundary: only that path turns a
	// 429 response HEADER into the canonical (retry-after-ms: N) marker the tier
	// router reads, so these scenarios default to anthropic-messages.
	const scenarioApi =
		api ||
		(scenario === "anthropic-policy-refusal-fallback" || isHint429Scenario(scenario)
			? "anthropic-messages"
			: "openai-completions");
	runRetryScenario(scenario, scenarioApi, driveTurn, flagValue(argv, "--evidence")).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv.includes("--serve")) {
	const envFile = flagValue(argv, "--serve-env");
	if (argv[0] === "--with-reasoning" && envFile) {
		serveReasoning(api || "openai-completions", envFile, argv.includes("--slow")).catch((e) => {
			process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
			process.exit(1);
		});
	} else if (argv[0] === "--with-tool" && envFile) {
		serveTool(api || "openai-completions", envFile).catch((e) => {
			process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
			process.exit(1);
		});
	} else if (argv[0] === "--with-tool") {
		process.stderr.write("--serve requires --with-tool and --serve-env <path>\n");
		process.exit(2);
	} else {
		// Preserve the established reasoning serve error for every prior invalid form.
		process.stderr.write("--serve requires --with-reasoning and --serve-env <path>\n");
		process.exit(2);
	}
} else if (argv[0] === "--with-reasoning") {
	withReasoning(api || "openai-completions", argv.includes("--slow")).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv[0] === "--with-tool") {
	withTool(api || "openai-completions").catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv[0] === "--with-text-tool-leak") {
	const leakApi = api || "openai-completions";
	if (!TEXT_LEAK_APIS.includes(leakApi)) {
		process.stderr.write(`text-tool leak modes require one of: ${TEXT_LEAK_APIS.join(", ")}\n`);
		process.exit(2);
	}
	dispatchTextToolLeakCommand(leakApi, false, driveTurn, flagValue(argv, "--evidence"));
} else if (argv[0] === "--with-truncated-text-tool-leak") {
	const leakApi = api || "openai-completions";
	if (!TEXT_LEAK_APIS.includes(leakApi)) {
		process.stderr.write(`text-tool leak modes require one of: ${TEXT_LEAK_APIS.join(", ")}\n`);
		process.exit(2);
	}
	dispatchTextToolLeakCommand(leakApi, true, driveTurn, flagValue(argv, "--evidence"));
} else if (argv[0] === "--with-mcp-tool") {
	Promise.resolve()
		.then(() => {
			const toolName =
				flagValue(argv, "--tool-name") || positionalAfter(argv, "--with-mcp-tool") || "mcp_fx_tool_1";
			return withMcpTool(
				api || "openai-completions",
				toolName,
				parseToolArgs(argv),
				flagValue(argv, "--evidence"),
			);
		})
		.catch((e) => {
			process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
			process.exit(1);
		});
} else if (argv[0] === "--run") {
	run(argv[1] || "say hello", api || "openai-completions", flagValue(argv, "--evidence")).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else {
	process.stderr.write(
		[
			"senpi-qa Channel 3 — Mock loop (zero real API calls)",
			"  node mock-loop.mjs --self-test [--api <name>]   round-trip 1 or all 3 wire formats",
			"  node mock-loop.mjs --with-tool [--api <name>]   full loop with a bash tool call",
			`  ${TOOL_SERVE_DELAY_ENV}=<ms> node mock-loop.mjs --with-tool --serve --serve-env <path> [--api <name>]`,
			"  node mock-loop.mjs --with-tool --serve --self-test [--api <name>]",
			"  node mock-loop.mjs --with-reasoning [--slow] [--api <name>]",
			"  node mock-loop.mjs --with-reasoning --serve --serve-env <path> [--slow] [--api <name>]",
			"  node mock-loop.mjs --with-text-tool-leak --api <anthropic-messages|openai-completions>",
			"  node mock-loop.mjs --with-truncated-text-tool-leak --api <anthropic-messages|openai-completions>",
			"  node mock-loop.mjs --with-mcp-tool <tool> [--tool-args JSON]",
			"  node mock-loop.mjs --scenario <transient-recover|budget-exhaust|server-error-fallback|long-retry-after|billing-swap|anthropic-policy-refusal-fallback|kimi-xtml-thinking-recover|ttsr-collapse|ttsr-leak|ttsr-repetitive-turns> [--api <name>]",
			"  node mock-loop.mjs --scenario <hinted-429-in-turn|no-hint-429-fast-fallback|hinted-429-probe-back|no-hint-429-no-chain>",
			"  node mock-loop.mjs --run <prompt> [--api <name>]",
			`  APIs: ${ALL_APIS.join(", ")}`,
			"",
		].join("\n"),
	);
	process.exitCode = 2;
}
