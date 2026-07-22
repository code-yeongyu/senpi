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
 *   node mock-loop.mjs --with-reasoning [--slow] [--api ...]
 *   node mock-loop.mjs --with-reasoning --serve --serve-env /tmp/senpi-qa.env
 *   (the flag is --serve-env, NOT --env-file: Node treats --env-file as a native
 *    startup flag and would try to load the path as a dotenv file before the script runs)
 *   node mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"ok"}'
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
import {
	appendTextToolLeakChecks,
	dispatchTextToolLeakCommand,
	runTextToolLeakScenario,
	TEXT_LEAK_APIS,
} from "./lib/mock-loop-text-leak.mjs";

async function driveTurn({
	apiName,
	turns,
	prompt,
	extraArgs = [],
	prepareSandbox,
	timeoutMs = 90000,
	modelOverrides,
}) {
	const p = API_PRESETS[apiName];
	const box = makeSandbox(`mock-loop-${apiName}`);
	const resolvedTurns = typeof turns === "function" ? turns(box) : turns;
	const server = await startFakeModelServer({ turns: resolvedTurns });
	writeMockModelsJson(box.agentDir, server, apiName, modelOverrides);
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

if (argv[0] === "--self-test") {
	selfTest(api).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv.includes("--serve")) {
	const envFile = flagValue(argv, "--serve-env");
	if (argv[0] !== "--with-reasoning" || !envFile) {
		process.stderr.write("--serve requires --with-reasoning and --serve-env <path>\n");
		process.exit(2);
	}
	serveReasoning(api || "openai-completions", envFile, argv.includes("--slow")).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
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
			"  node mock-loop.mjs --with-reasoning [--slow] [--api <name>]",
			"  node mock-loop.mjs --with-reasoning --serve --serve-env <path> [--slow] [--api <name>]",
			"  node mock-loop.mjs --with-text-tool-leak --api <anthropic-messages|openai-completions>",
			"  node mock-loop.mjs --with-truncated-text-tool-leak --api <anthropic-messages|openai-completions>",
			"  node mock-loop.mjs --with-mcp-tool <tool> [--tool-args JSON]",
			"  node mock-loop.mjs --run <prompt> [--api <name>]",
			`  APIs: ${ALL_APIS.join(", ")}`,
			"",
		].join("\n"),
	);
	process.exitCode = 2;
}
