#!/usr/bin/env node
/**
 * Real-surface probe: a provider stream-start timeout on the claude-sdk-oauth
 * lane must surface an error that names the knob users can raise
 * (retry.provider.streamStartTimeoutMs).
 *
 * Drives createAgentSession() -> AgentSession.prompt() -> resident
 * claude-sdk-oauth query -> the real Claude Code subprocess against a loopback
 * Anthropic server that HOLDS its response past the configured 2s guard. No
 * credentials, no network egress.
 *
 * Usage: bun .agents/skills/senpi-qa/scripts/claude-sdk-oauth-stream-start-knob-probe.mjs [--evidence <dir>]
 */

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { guardRealAuth, installCleanupHooks, makeSandbox, repoRoot, track } from "./lib/common.mjs";
import { loopbackSseBody, seedProbeAgentDir } from "./lib/claude-sdk-oauth-fullstack-support.mjs";
import { applyHermeticEnvironment, assertHermeticEnvironment } from "./lib/claude-sdk-oauth-hermetic-env.mjs";
import { withTimeout } from "./lib/with-timeout.mjs";

const ROOT = repoRoot();
const MODEL_ID = "claude-haiku-4-5";
const STREAM_START_TIMEOUT_MS = 2_000;
const HOLD_MS = 12_000;
const KNOB = "retry.provider.streamStartTimeoutMs";

const argv = process.argv.slice(2);
const evidenceArg = argv.indexOf("--evidence");
const evidenceDir = evidenceArg === -1 ? undefined : argv[evidenceArg + 1];

installCleanupHooks();

const requests = [];
function startLoopbackServer() {
	return new Promise((resolve, reject) => {
		const server = track(
			createServer((request, response) => {
				if (request.method !== "POST") {
					response.writeHead(200);
					response.end();
					return;
				}
				request.resume();
				request.on("end", () => {
					const sequence = requests.length + 1;
					requests.push({ sequence, heldMs: HOLD_MS });
					// Hold the response past the stream-start guard, then answer so the
					// CLI can wind down instead of leaking a socket.
					const timer = setTimeout(() => {
						if (response.destroyed) return;
						response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
						response.end(loopbackSseBody("late reply", sequence));
					}, HOLD_MS);
					response.on("close", () => clearTimeout(timer));
				});
			}),
		);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
	});
}

const authGuard = guardRealAuth();
const box = makeSandbox("claude-sdk-stream-start-knob-probe");
let server;
let session;
let closeSession;
let fatal;
let outcome = { errorMessage: null, stopReason: null };
try {
	({ server, baseUrl: box.baseUrl } = await startLoopbackServer());
	seedProbeAgentDir(box.agentDir);
	writeFileSync(
		join(box.agentDir, "settings.json"),
		JSON.stringify({ retry: { enabled: false, provider: { streamStartTimeoutMs: STREAM_START_TIMEOUT_MS, timeoutMs: 60_000 } } }),
	);
	const claudeConfigDir = join(box.dir, "claude-config");
	mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
	writeFileSync(
		join(claudeConfigDir, ".credentials.json"),
		JSON.stringify({ claudeAiOauth: { accessToken: "knob-probe-dummy-access", refreshToken: "knob-probe-dummy-refresh", expiresAt: 4102444800000, scopes: ["user:inference", "user:profile", "user:sessions:claude_code"] } }),
		{ mode: 0o600 },
	);
	applyHermeticEnvironment(process.env, {
		HOME: box.dir,
		USERPROFILE: box.dir,
		TMPDIR: box.dir,
		SENPI_CODING_AGENT_DIR: box.agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: box.sessionDir,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		ANTHROPIC_BASE_URL: box.baseUrl,
		ANTHROPIC_API_KEY: "knob-probe-dummy-key",
		CLAUDE_CONFIG_DIR: claudeConfigDir,
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_DISABLE_TELEMETRY: "1",
		SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION: "ambient",
		SENPI_CLAUDE_SDK_OAUTH_ENABLED: "1",
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	});
	assertHermeticEnvironment(process.env, box.baseUrl);

	const sourceRoot = join(ROOT, "packages", "coding-agent", "src");
	({ closeSession } = await import(pathToFileURL(join(sourceRoot, "core", "extensions", "builtin", "claude-sdk-oauth", "session-registry.ts")).href));
	const { createAgentSession } = await import(pathToFileURL(join(sourceRoot, "index.ts")).href);
	const created = await createAgentSession({ cwd: box.cwd, agentDir: box.agentDir, noTools: "all", autoTitleSessions: false });
	session = created.session;
	const model = session.modelRuntime.getModel("claude-sdk-oauth", MODEL_ID);
	if (!model) throw new Error("claude-sdk-oauth provider did not register its models");
	await session.setModel(model);
	await withTimeout(session.prompt("Reply with TOKEN_KNOB.", { sessionTitlePrompt: false }), "stalled turn", 90_000);
	const assistant = [...session.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message?.role === "assistant");
	outcome = {
		requests: requests.length,
		stopReason: assistant?.message?.stopReason ?? null,
		errorMessage: assistant?.message?.errorMessage ?? null,
	};
} catch (error) {
	fatal = error instanceof Error ? error : new Error(String(error));
} finally {
	try { if (session?.id && closeSession) closeSession(session.id, "probe_shutdown"); } catch {}
	try { session?.dispose?.(); } catch {}
	if (server) await new Promise((resolve) => server.close(resolve));
	try { authGuard.assertUnchanged(); } catch (error) { fatal = fatal ?? (error instanceof Error ? error : new Error(String(error))); }
	box.cleanup();
}

let verdict;
if (fatal && /loopback|ECONNREFUSED|EADDRINUSE|claude_binary_not_found|Native CLI binary.*not found/i.test(fatal.message)) {
	verdict = `REJECTED signal=loopback_unreachable detail=${fatal.message}`;
	process.exitCode = 2;
} else if (fatal) {
	verdict = `FAIL signal=probe_error detail=${fatal.message}`;
	process.exitCode = 1;
} else {
	const timedOut = typeof outcome.errorMessage === "string" && /stream start timed out/i.test(outcome.errorMessage);
	const named = typeof outcome.errorMessage === "string" && outcome.errorMessage.includes(KNOB);
	const ok = outcome.stopReason === "error" && timedOut && named;
	verdict = ok
		? `PASS stopReason=error knobNamed=true message=${JSON.stringify(outcome.errorMessage)}`
		: `FAIL stopReason=${outcome.stopReason} timedOut=${timedOut} knobNamed=${named} message=${JSON.stringify(outcome.errorMessage)} requests=${outcome.requests}`;
	process.exitCode = ok ? 0 : 1;
}
process.stdout.write(`${verdict}\n`);
if (evidenceDir) {
	mkdirSync(evidenceDir, { recursive: true });
	const file = join(evidenceDir, "stream-start-knob.json");
	writeFileSync(file, JSON.stringify({ verdict, outcome, fatal: fatal?.message ?? null }, null, 2));
	process.stdout.write(`evidence=${file}\n`);
}
