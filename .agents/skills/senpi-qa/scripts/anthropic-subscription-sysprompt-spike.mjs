#!/usr/bin/env node
/**
 * Live plain-string system-prompt spike for the managed claude-sdk-oauth lane.
 *
 * Verifies that subscription OAuth accepts one SDK turn when systemPrompt is a
 * plain string that does not contain the Claude Code identity line.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/anthropic-subscription-sysprompt-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED sysprompt=plain-string"
 *   exit 2 "REJECTED signal=<result.subtype|terminal_reason|status>"
 * Never prints token material.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (process.env.SENPI_LIVE_CLAUDE_SDK_OAUTH !== "1") {
	console.log("SKIPPED: set SENPI_LIVE_CLAUDE_SDK_OAUTH=1 to run the live spike");
	process.exit(0);
}

const sandbox = process.env.SENPI_CODING_AGENT_DIR;
if (!sandbox) {
	console.error("REJECTED: SENPI_CODING_AGENT_DIR must point at the seeded sandbox");
	process.exit(2);
}

let stored;
try {
	stored = JSON.parse(readFileSync(join(sandbox, "auth.json"), "utf8"));
} catch {
	console.error("REJECTED: sandbox auth.json unreadable");
	process.exit(2);
}

const credential = stored["claude-sdk-oauth-spike"] ?? stored.anthropic;
if (!credential || credential.type !== "oauth" || typeof credential.access !== "string") {
	console.error("REJECTED: sandbox auth.json has no usable oauth credential");
	process.exit(2);
}

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { resolveClaudeCodeExecutable, defaultExecutableDeps } = await import(
	"../../../packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/executable.ts"
);

function managedEnvironment(access) {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.ANTHROPIC_BASE_URL;
	delete env.ANTHROPIC_CUSTOM_HEADERS;
	delete env.CLAUDECODE;
	delete env.CLAUDE_CODE_USE_BEDROCK;
	delete env.CLAUDE_CODE_USE_FOUNDRY;
	delete env.CLAUDE_CODE_USE_GATEWAY;
	delete env.CLAUDE_CODE_USE_VERTEX;
	for (const name of Object.keys(env)) {
		if (/^CLAUDE_CODE_OAUTH_TOKEN(?:_\d+)?$/.test(name)) delete env[name];
	}
	return { ...env, CLAUDE_CODE_OAUTH_TOKEN: access };
}

function safeSignal(value) {
	return String(value ?? "unknown")
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "_")
		.slice(0, 80);
}

const executable = resolveClaudeCodeExecutable(defaultExecutableDeps());
const stream = query({
	prompt: "Reply with exactly: ok",
	options: {
		model: "claude-haiku-4-5",
		maxTurns: 1,
		tools: [],
		permissionMode: "dontAsk",
		pathToClaudeCodeExecutable: executable,
		settingSources: [],
		systemPrompt: "Answer the user's request directly and concisely.",
		env: managedEnvironment(credential.access),
	},
});

let sawAssistant = false;
let assistantStatus = null;
let result = null;
let authStatus = null;
try {
	for await (const message of stream) {
		if (message.type === "assistant") {
			sawAssistant = true;
			if (message.error) assistantStatus = message.error;
		}
		if (message.type === "auth_status" && message.error) authStatus = "authentication_failed";
		if (message.type === "result") result = message;
	}
} catch {
	assistantStatus ??= "sdk_exception";
} finally {
	try {
		stream.close();
	} catch {
		// close best-effort
	}
}

if (sawAssistant && !assistantStatus && result?.subtype === "success") {
	console.log("ACCEPTED sysprompt=plain-string");
	process.exit(0);
}

const signal = result?.subtype ?? result?.terminal_reason ?? assistantStatus ?? authStatus ?? "no_assistant";
console.error(`REJECTED signal=${safeSignal(signal)}`);
process.exit(2);
