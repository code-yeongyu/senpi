#!/usr/bin/env node
/**
 * Live auth spike for the claude-sdk-oauth provider (todo 3, opt-in).
 *
 * Verifies which multi-account lane the real Claude Code subprocess accepts:
 *   lane=oauth-slots : access token injected as CLAUDE_CODE_OAUTH_TOKEN via Options.env
 *   lane=config-dir  : per-account CLAUDE_CONFIG_DIR with a .credentials.json
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/anthropic-subscription-auth-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED lane=oauth-slots" | exit 0 "ACCEPTED lane=config-dir" | exit 2 "REJECTED"
 * Never prints token material.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
} catch (error) {
	console.error(`REJECTED: sandbox auth.json unreadable: ${error instanceof Error ? error.message : error}`);
	process.exit(2);
}

const credential = stored["claude-sdk-oauth-spike"] ?? stored["anthropic"];
if (!credential || credential.type !== "oauth" || typeof credential.access !== "string") {
	console.error("REJECTED: sandbox auth.json has no usable oauth credential");
	process.exit(2);
}

const { query } = await import("@anthropic-ai/claude-agent-sdk");
const { resolveClaudeCodeExecutable, defaultExecutableDeps } = await import(
	"../../../packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/executable.ts"
);

const executable = resolveClaudeCodeExecutable(defaultExecutableDeps());

function neutralizedEnv(extra) {
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	delete env.CLAUDECODE;
	return { ...env, ...extra };
}

async function attempt(lane, extraEnv) {
	const q = query({
		prompt: "Reply with exactly: ok",
		options: {
			model: "claude-haiku-4-5",
			maxTurns: 1,
			tools: [],
			permissionMode: "dontAsk",
			pathToClaudeCodeExecutable: executable,
			settingSources: [],
			env: neutralizedEnv(extraEnv),
		},
	});
	let sawAssistant = false;
	let authError = null;
	try {
		for await (const message of q) {
			if (message.type === "assistant") sawAssistant = true;
			if (message.type === "result" && message.subtype !== "success") {
				authError = `${message.subtype}`;
			}
			if (message.type === "assistant" && message.error) {
				authError = `${message.error}`;
			}
		}
	} catch (error) {
		authError = error instanceof Error ? error.message.slice(0, 120) : `${error}`;
	} finally {
		try {
			q.close();
		} catch {
			// close best-effort
		}
	}
	if (sawAssistant && !authError) return { ok: true };
	return { ok: false, error: authError ?? "no assistant message" };
}

const direct = await attempt("oauth-slots", { CLAUDE_CODE_OAUTH_TOKEN: credential.access });
if (direct.ok) {
	console.log(`ACCEPTED lane=oauth-slots`);
	process.exit(0);
}
console.error(`lane=oauth-slots rejected (${(direct.error ?? "unknown").replaceAll(/sk-[^\s"]+/g, "[redacted]")})`);

const configDir = mkdtempSync(join(tmpdir(), "claude-sdk-oauth-spike-"));
try {
	writeFileSync(
		join(configDir, ".credentials.json"),
		JSON.stringify({
			claudeAiOauth: {
				accessToken: credential.access,
				refreshToken: credential.refresh,
				expiresAt: credential.expires,
				scopes: credential.scopes ?? ["user:inference", "user:profile", "user:sessions:claude_code"],
			},
		}),
		{ mode: 0o600 },
	);
	const viaConfigDir = await attempt("config-dir", { CLAUDE_CONFIG_DIR: configDir });
	if (viaConfigDir.ok) {
		console.log(`ACCEPTED lane=config-dir`);
		process.exit(0);
	}
	console.error(`lane=config-dir rejected (${(viaConfigDir.error ?? "unknown").replaceAll(/sk-[^\s"]+/g, "[redacted]")})`);
} finally {
	rmSync(configDir, { recursive: true, force: true });
}

console.error("REJECTED");
process.exit(2);
