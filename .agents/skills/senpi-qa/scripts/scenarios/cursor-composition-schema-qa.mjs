#!/usr/bin/env node
/**
 * QA scenario: a tool whose inputSchema carries a JSON-Schema composition
 * keyword (`oneOf`/`anyOf`/`allOf`) must NOT break the cursor provider.
 *
 * Root cause (2026-08-18): Cursor's gateway forwards advertised MCP tool
 * schemas upstream and rejects the WHOLE request with a wrapped provider 400
 * (zero tokens, `resource_exhausted` end-stream) when any schema contains a
 * composition keyword. ast-grep MCP's `scan` tool ships a top-level `oneOf`,
 * so every session that registered it failed on cursor from turn 1.
 * Fixed by `sanitizeCursorToolSchema` in packages/ai/src/api/cursor-agent.ts.
 *
 * This drives the REAL CLI in a hermetic sandbox with an extension registering
 * one MCP stdio server exposing a poisoned `scan`-style tool, then asks the
 * cursor model to reply. Binary observable:
 *   - answer text arrives, no provider error  -> fixed
 *   - "Connect error resource_exhausted"      -> regression
 *
 * Live-gated: requires SENPI_QA_CURSOR_TOKEN (a Cursor session access token)
 * and SKIPS otherwise (hermetic default runs never touch real credentials).

 * Usage: node cursor-composition-schema-qa.mjs [--evidence SLUG]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, repoRoot } from "../lib/common.mjs";

const MODEL = "claude-fable-5-thinking-xhigh";

function parseArgs(argv) {
	const options = { evidence: undefined };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--evidence") {
			const next = argv[++i];
			if (!next) throw new Error("--evidence requires a value");
			options.evidence = next;
		} else {
			throw new Error(`Unknown option: ${argv[i]}`);
		}
	}
	return options;
}

const { evidence } = parseArgs(process.argv.slice(2));

if (!process.env.SENPI_QA_CURSOR_TOKEN) {
	console.log("SKIP: set SENPI_QA_CURSOR_TOKEN to run the live cursor composition-schema check");
	process.exit(0);
}

const box = makeSandbox();
installCleanupHooks(box);
const authGuard = guardRealAuth();

const checks = createChecks(evidence ? evidenceDir(evidence) : undefined);

// One MCP stdio server exposing a scan-style poisoned schema plus a clean tool.
const serverDir = join(box.dir, "asg-mcp");
mkdirSync(serverDir, { recursive: true });
writeFileSync(
	join(serverDir, "server.mjs"),
	[
		'import { createInterface } from "node:readline";',
		"const tools = [",
		"  { name: 'scan', description: 'scan things', inputSchema: { type: 'object', properties: { ruleFile: { type: 'string' }, inlineRules: { type: 'string' } }, required: ['ruleFile'], oneOf: [ { type: 'object', required: ['ruleFile'], not: { required: ['inlineRules'] } }, { type: 'object', required: ['inlineRules'], not: { required: ['ruleFile'] } } ] } },",
		"  { name: 'search', description: 'search things', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },",
		"];",
		'const rl = createInterface({ input: process.stdin });',
		'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");',
		'rl.on("line", (line) => {',
		"  let req; try { req = JSON.parse(line); } catch { return; }",
		'  if (req.method === "initialize") send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "poisoned", version: "1.0" } } });',
		'  else if (req.method === "tools/list") send({ jsonrpc: "2.0", id: req.id, result: { tools } });',
		"  else if (req.id !== undefined) send({ jsonrpc: \"2.0\", id: req.id, result: {} });",
		"});",
	].join("\n"),
);

const extDir = join(box.dir, "ext");
mkdirSync(extDir, { recursive: true });
writeFileSync(
	join(extDir, "index.ts"),
	[
		'import { join, dirname } from "node:path";',
		'import { fileURLToPath } from "node:url";',
		'const here = dirname(fileURLToPath(import.meta.url));',
		"export default function (pi) {",
		'  pi.registerMcpServer("_poison_grep", { type: "stdio", command: process.execPath, args: [join(here, "..", "asg-mcp", "server.mjs")], env: {}, enabled: true, lifecycle: "eager" });',
		"}",
	].join("\n"),
);

// Sandbox agent dir already exists (makeSandbox); point the cursor provider at the live API.
const modelsPath = join(box.env.SENPI_CODING_AGENT_DIR, "models.json");
let models = { providers: {} };
try {
	models = JSON.parse(readFileSync(modelsPath, "utf8"));
} catch {
	// fresh sandbox: start from an empty catalog
}
models.providers = models.providers ?? {};
models.providers.cursor = {
	name: "Cursor (QA)",
	api: "cursor-agent",
	baseUrl: "https://api2.cursor.sh",
	models: [
		{
			id: MODEL,
			name: "Claude Fable 5 1M Extra High Thinking (QA)",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1000000,
			maxTokens: 64000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	],
};
writeFileSync(modelsPath, JSON.stringify(models, null, 1));

// Explicit opt-in credential: the token arrives via SENPI_QA_CURSOR_TOKEN and is
// written only into the hermetic sandbox's auth store (never the real one).
const authPath = join(box.env.SENPI_CODING_AGENT_DIR, "auth.json");
let auth = {};
try {
	auth = JSON.parse(readFileSync(authPath, "utf8"));
} catch {
	// fresh sandbox: start from an empty auth store
}
auth.cursor = {
	type: "oauth",
	access: process.env.SENPI_QA_CURSOR_TOKEN,
	refresh: "qa-unused",
	expires: Date.now() + 3_600_000,
};
writeFileSync(authPath, JSON.stringify(auth, null, 1));

const runRoot = join(box.dir, "run");
mkdirSync(runRoot, { recursive: true });
const { status, stdout, stderr } = (() => {
	try {
		const out = execFileSync(
			process.execPath,
			[
				join(repoRoot(), "packages", "coding-agent", "dist", "cli.js"),
				"-p",
				"Reply with exactly: OK",
				"--extension",
				join(extDir, "index.ts"),
				"--provider",
				"cursor",
				"--model",
				MODEL,
			],
			{ cwd: runRoot, env: box.env, encoding: "utf8", timeout: 120_000 },
		);
		return { status: 0, stdout: out, stderr: "" };
	} catch (error) {
		return { status: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
})();

const combined = `${stdout}\n${stderr}`;
const answered = /OK/.test(stdout);
const poisoned = /resource_exhausted/.test(combined);

checks.ok(
	"cursor answers with poisoned-schema tool registered",
	answered && !poisoned,
	`exit=${status} poisoned=${poisoned} tail=${JSON.stringify(stdout.slice(-80))}`,
);

authGuard.assertUnchanged();
rmSync(box.dir, { recursive: true, force: true });
checks.finish();
