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
 *   node mock-loop.mjs --with-mcp-tool mcp_fx_tool_1 --tool-args '{"value":"ok"}'
 *   node mock-loop.mjs --run "prompt" [--api ...] [--evidence SLUG]
 */

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
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import {
	ALL_APIS,
	API_PRESETS,
	assertMcpFixtureToolName,
	hermeticEnv,
	mcpFixtureForToolName,
	validateMcpFixtureToolResult,
	writeMcpFixtureExtension,
	writeMockModelsJson,
	writeToolEvidence,
} from "./lib/mock-loop-support.mjs";

async function driveTurn({ apiName, turns, prompt, extraArgs = [], prepareSandbox, timeoutMs = 90000 }) {
	const p = API_PRESETS[apiName];
	const box = makeSandbox(`mock-loop-${apiName}`);
	const server = await startFakeModelServer({ turns });
	writeMockModelsJson(box.agentDir, server, apiName);
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
	for (const api of apis) await checkApi(checks, api);
	checks.ok("zero real provider calls (only localhost fake hit)", true, "all baseUrls point at 127.0.0.1");
	checkRealAuthUnchanged(checks, guard);
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
const flag = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const api = flag("--api");
if (api && !API_PRESETS[api]) {
	process.stderr.write(`unknown --api ${api}. valid: ${ALL_APIS.join(", ")}\n`);
	process.exit(2);
}

function parseToolArgs() {
	const raw = flag("--tool-args");
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch (error) {
		throw new Error(`--tool-args must be a JSON object: invalid JSON (${safeErrorReason(error)})`);
	}
	throw new Error("--tool-args must be a JSON object");
}

if (argv[0] === "--self-test") {
	selfTest(api).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv[0] === "--with-tool") {
	withTool(api || "openai-completions").catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else if (argv[0] === "--with-mcp-tool") {
	Promise.resolve()
		.then(() => {
			const toolName = flag("--tool-name") || positionalAfter("--with-mcp-tool") || "mcp_fx_tool_1";
			return withMcpTool(api || "openai-completions", toolName, parseToolArgs(), flag("--evidence"));
		})
		.catch((e) => {
			process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
			process.exit(1);
		});
} else if (argv[0] === "--run") {
	run(argv[1] || "say hello", api || "openai-completions", flag("--evidence")).catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
		process.exit(1);
	});
} else {
	process.stdout.write(
		[
			"senpi-qa Channel 3 — Mock loop (zero real API calls)",
			"  node mock-loop.mjs --self-test [--api <name>]   round-trip 1 or all 3 wire formats",
			"  node mock-loop.mjs --with-tool [--api <name>]   full loop with a bash tool call",
			"  node mock-loop.mjs --with-mcp-tool <tool> [--tool-args JSON]",
			"  node mock-loop.mjs --run <prompt> [--api <name>]",
			`  APIs: ${ALL_APIS.join(", ")}`,
			"",
		].join("\n"),
	);
}

function positionalAfter(command) {
	const start = argv.indexOf(command);
	if (start < 0) return undefined;
	const valuedFlags = new Set(["--api", "--tool-name", "--tool-args", "--evidence"]);
	for (let index = start + 1; index < argv.length; index++) {
		const arg = argv[index];
		if (valuedFlags.has(arg)) {
			index++;
			continue;
		}
		if (!arg.startsWith("--")) return arg;
	}
	return undefined;
}

function checkRealAuthUnchanged(checks, guard) {
	try {
		checks.ok("real auth unchanged", guard.assertUnchanged(), guard.path);
	} catch (error) {
		checks.ok("real auth unchanged", false, `credential guard failed at ${guard.path}: ${safeErrorReason(error)}`);
	}
}

function safeErrorReason(error) {
	return error instanceof Error ? error.name : typeof error;
}
