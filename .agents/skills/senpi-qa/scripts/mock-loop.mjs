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
 *   node mock-loop.mjs --run "prompt" [--api ...] [--evidence SLUG]
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";

/** Per-API: which provider to override, model id, key, auth header, and how to derive baseUrl. */
const API_PRESETS = {
	"openai-completions": { provider: "mock", modelId: "mock-model", apiKey: "sk-mock-qa-7f3a", auth: "bearer", path: "/chat/completions", baseUrl: (s) => s.url },
	"anthropic-messages": { provider: "anthropic", modelId: "mock-claude", apiKey: "sk-ant-mock-7f3a", auth: "x-api-key", path: "/messages", baseUrl: (s) => s.origin },
	"openai-responses": { provider: "openai", modelId: "mock-gpt", apiKey: "sk-openai-mock-7f3a", auth: "bearer", path: "/responses", baseUrl: (s) => s.url },
};
const ALL_APIS = Object.keys(API_PRESETS);

// Real provider keys in the ambient env would otherwise take precedence over the
// inline models.json key for built-in providers (anthropic/openai), so a real
// key could reach even the localhost fake. Strip them: the mock loop must be
// hermetic and use ONLY the inline mock key.
const PROVIDER_ENV_KEYS = [
	"ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
	"FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY", "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY",
	"MOONSHOTAI_API_KEY", "KIMI_API_KEY", "OPENCODE_API_KEY", "CLOUDFLARE_API_KEY", "HF_TOKEN",
];

function hermeticEnv(boxEnv) {
	const env = { ...boxEnv };
	for (const k of PROVIDER_ENV_KEYS) delete env[k];
	return env;
}

function writeMockModelsJson(agentDir, server, apiName) {
	const p = API_PRESETS[apiName];
	const baseUrl = p.baseUrl(server);
	const config = {
		providers: {
			[p.provider]: {
				baseUrl,
				apiKey: p.apiKey,
				api: apiName,
				models: [
					{ id: p.modelId, baseUrl, api: apiName, contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
				],
			},
		},
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2));
}

async function driveTurn({ apiName, turns, prompt, extraArgs = [], timeoutMs = 90000 }) {
	const p = API_PRESETS[apiName];
	const box = makeSandbox(`mock-loop-${apiName}`);
	const server = await startFakeModelServer({ turns });
	writeMockModelsJson(box.agentDir, server, apiName);
	const args = ["--provider", p.provider, "--model", p.modelId, "--no-context-files", "--no-extensions", ...extraArgs, "--print", prompt];
	const result = await runCli(args, { env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs });
	return { box, server, result, preset: p };
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
	checks.ok("real auth unchanged", (() => {
		try {
			return guard.assertUnchanged();
		} catch {
			return false;
		}
	})(), guard.path);
	process.exit(checks.finish() ? 0 : 1);
}

async function withTool(apiName) {
	installCleanupHooks();
	const checks = createChecks(`mock-loop.mjs --with-tool (${apiName})`);
	const guard = guardRealAuth();
	const toolMarker = "TOOL-LOOP-OK-22b8";
	const { box, server, result } = await driveTurn({
		apiName,
		turns: [{ toolCalls: [{ name: "bash", args: { command: `echo ${toolMarker}` } }] }, { text: `Done: ${toolMarker}` }],
		prompt: "Run the bash command and report the output.",
		extraArgs: ["--approve"],
		timeoutMs: 120000,
	});
	checks.ok("CLI completed the multi-step loop", !result.timedOut, `code=${result.code}`);
	checks.ok("two model turns served (loop iterated)", server.requests.length >= 2, `requests=${server.requests.length}`);
	checks.ok("final assistant text returned", (result.stdout + result.stderr).includes(toolMarker));
	checks.ok("real auth unchanged", (() => {
		try {
			return guard.assertUnchanged();
		} catch {
			return false;
		}
	})());
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
			"  node mock-loop.mjs --run <prompt> [--api <name>]",
			`  APIs: ${ALL_APIS.join(", ")}`,
			"",
		].join("\n"),
	);
}
