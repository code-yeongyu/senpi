#!/usr/bin/env node
/**
 * Live persistent-query spike for the managed claude-sdk-oauth lane.
 *
 * Keeps one streaming SDK query alive across two user turns and observes:
 *   - PreToolUse denial of a host-captured Bash call plus coherent recovery
 *     after the host supplies the result as the next user message;
 *   - SDK user-message replay preserving a host-submitted UUID;
 *   - Claude Code subprocess cleanup after the SDK-host process exits without
 *     closing its still-live query.
 *
 * Usage:
 *   SENPI_LIVE_CLAUDE_SDK_OAUTH=1 SENPI_CODING_AGENT_DIR=<sandbox> \
 *     node .agents/skills/senpi-qa/scripts/anthropic-subscription-persistent-query-spike.mjs
 *
 * Outcomes (final line):
 *   exit 0 "ACCEPTED denial=<ok|degraded> orphan=none replay=<uuid-match|absent>"
 *   exit 2 "REJECTED signal=<result.subtype|terminal_reason|status|orphan_leaked>"
 * Never prints token material.
 */
import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_ARGUMENT = "--persistent-query-worker";

if (process.env.SENPI_LIVE_CLAUDE_SDK_OAUTH !== "1") {
	console.log("SKIPPED: set SENPI_LIVE_CLAUDE_SDK_OAUTH=1 to run the live spike");
	process.exit(0);
}

const sandbox = process.env.SENPI_CODING_AGENT_DIR;
if (!sandbox) {
	console.error("REJECTED: SENPI_CODING_AGENT_DIR must point at the seeded sandbox");
	process.exit(2);
}

function loadCredential() {
	let stored;
	try {
		stored = JSON.parse(readFileSync(join(sandbox, "auth.json"), "utf8"));
	} catch {
		return { error: "REJECTED: sandbox auth.json unreadable" };
	}
	const credential = stored["claude-sdk-oauth-spike"] ?? stored.anthropic;
	if (!credential || credential.type !== "oauth" || typeof credential.access !== "string") {
		return { error: "REJECTED: sandbox auth.json has no usable oauth credential" };
	}
	return { credential };
}

function safeSignal(value) {
	return String(value ?? "unknown")
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "_")
		.slice(0, 80);
}

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

function userMessage(text, uuid) {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		uuid,
	};
}

function controlledInput(initialMessage) {
	const pending = [initialMessage];
	const waiters = [];
	return {
		push(message) {
			const waiter = waiters.shift();
			if (waiter) waiter({ value: message, done: false });
			else pending.push(message);
		},
		[Symbol.asyncIterator]() {
			return {
				next() {
					const message = pending.shift();
					if (message) return Promise.resolve({ value: message, done: false });
					return new Promise((resolve) => waiters.push(resolve));
				},
			};
		},
	};
}

function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function toolResultText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && block.type === "tool_result")
		.map((block) => contentText(block.content))
		.join("\n");
}

function sendWorkerResult(message) {
	if (!process.send) process.exit(2);
	process.send(message, () => process.exit(message.kind === "observation" ? 0 : 2));
}

async function runWorker() {
	const loaded = loadCredential();
	if (loaded.error) {
		sendWorkerResult({ kind: "rejected", signal: "credential_unavailable" });
		return;
	}

	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const { resolveClaudeCodeExecutable, defaultExecutableDeps } = await import(
		"../../../packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/executable.ts"
	);
	const {
		BUILTIN_SDK_TOOLS,
		HOST_CAPTURED_SDK_TOOL_MATCHER,
		HOST_TOOL_DENIAL_HOOKS,
		HOST_TOOL_EXECUTION_DENIED_MESSAGE,
	} = await import("../../../packages/coding-agent/src/core/extensions/builtin/anthropic-subscription/tools.ts");

	if (!new RegExp(`^(?:${HOST_CAPTURED_SDK_TOOL_MATCHER})$`).test("Bash")) {
		sendWorkerResult({ kind: "rejected", signal: "host_matcher_mismatch" });
		return;
	}

	const firstUuid = randomUUID();
	const followupUuid = randomUUID();
	const hostResult = `HOST_RESULT_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const input = controlledInput(
		userMessage(
			"Call the Bash tool exactly once with command: printf SENPI_PERSISTENT_QUERY_PROBE. Do not answer without calling it.",
			firstUuid,
		),
	);
	let claudePid = null;
	let sawBash = false;
	let sawHookDenial = false;
	let sawReplayMatch = false;
	let coherent = false;
	let sentFollowup = false;
	let resultCount = 0;
	let lastFailureSignal = null;

	const timeout = setTimeout(() => sendWorkerResult({ kind: "rejected", signal: "timeout" }), 180_000);
	timeout.unref();

	try {
		const stream = query({
			prompt: input,
			options: {
				model: "claude-haiku-4-5",
				maxTurns: 4,
				tools: [...BUILTIN_SDK_TOOLS],
				permissionMode: "dontAsk",
				hooks: HOST_TOOL_DENIAL_HOOKS,
				includeHookEvents: true,
				pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(defaultExecutableDeps()),
				settingSources: [],
				systemPrompt:
					"Follow the user's tool-call instruction. After the host provides a tool result in the next user message, acknowledge it exactly as requested.",
				extraArgs: { "replay-user-messages": "" },
				env: managedEnvironment(loaded.credential.access),
				canUseTool: async () => ({ behavior: "deny", message: HOST_TOOL_EXECUTION_DENIED_MESSAGE }),
				spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
					const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] });
					claudePid = child.pid ?? null;
					return child;
				},
			},
		});

		for await (const message of stream) {
			if (message.type === "user" && message.isReplay === true) {
				sawReplayMatch ||= message.uuid === firstUuid || message.uuid === followupUuid;
			}
			if (message.type === "assistant") {
				if (message.error) lastFailureSignal = message.error;
				for (const block of message.message.content) {
					if (block.type === "tool_use" && block.name === "Bash") sawBash = true;
					if (block.type === "text" && block.text.includes(`COHERENT: ${hostResult}`)) coherent = true;
				}
			}
			if (message.type === "user") {
				const denialText = toolResultText(message.message.content);
				if (denialText.includes(HOST_TOOL_EXECUTION_DENIED_MESSAGE)) sawHookDenial = true;
			}
			if (message.type === "auth_status" && message.error) lastFailureSignal = "authentication_failed";
			if (message.type === "result") {
				resultCount++;
				if (message.subtype !== "success") {
					clearTimeout(timeout);
					sendWorkerResult({
						kind: "rejected",
						signal: message.subtype ?? message.terminal_reason ?? lastFailureSignal ?? "result_error",
					});
					return;
				}
				if (!sentFollowup) {
					sentFollowup = true;
					input.push(
						userMessage(
							`The host captured the Bash call and supplied this result: ${hostResult}. Reply with exactly: COHERENT: ${hostResult}`,
							followupUuid,
						),
					);
					continue;
				}
				if (resultCount >= 2) {
					clearTimeout(timeout);
					if (!coherent) {
						sendWorkerResult({ kind: "rejected", signal: lastFailureSignal ?? "incoherent_followup" });
						return;
					}
					sendWorkerResult({
						kind: "observation",
						pid: claudePid,
						denial: sawBash && sawHookDenial ? "ok" : "degraded",
						replay: sawReplayMatch ? "uuid-match" : "absent",
					});
					return;
				}
			}
		}
		sendWorkerResult({ kind: "rejected", signal: lastFailureSignal ?? "stream_ended" });
	} catch {
		clearTimeout(timeout);
		sendWorkerResult({ kind: "rejected", signal: lastFailureSignal ?? "sdk_exception" });
	}
}

function processExists(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && typeof error === "object" && "code" in error && error.code === "EPERM";
	}
}

async function waitForProcessExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (processExists(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !processExists(pid);
}

async function runSupervisor() {
	const loaded = loadCredential();
	if (loaded.error) {
		console.error(loaded.error);
		process.exit(2);
	}

	const worker = fork(fileURLToPath(import.meta.url), [WORKER_ARGUMENT], {
		env: process.env,
		silent: true,
	});
	const workerExit = new Promise((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
	const workerMessage = new Promise((resolve) => worker.once("message", resolve));
	const watchdog = setTimeout(() => worker.kill("SIGKILL"), 190_000);
	watchdog.unref();

	const firstEvent = await Promise.race([
		workerMessage.then((message) => ({ message })),
		workerExit.then((exit) => ({ exit })),
	]);
	const message = "message" in firstEvent ? firstEvent.message : null;
	const exit = "exit" in firstEvent ? firstEvent.exit : await workerExit;
	clearTimeout(watchdog);
	if (!message || typeof message !== "object" || message.kind !== "observation") {
		const signal =
			message && typeof message === "object" && message.kind === "rejected"
				? message.signal
				: `worker_${exit.signal ?? exit.code ?? "exit"}`;
		console.error(`REJECTED signal=${safeSignal(signal)}`);
		process.exit(2);
	}

	const pid = Number.isInteger(message.pid) ? message.pid : null;
	const gone = pid !== null && (await waitForProcessExit(pid, 5_000));
	if (!gone) {
		if (pid !== null) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		console.error(`REJECTED signal=orphan_leaked denial=${message.denial} orphan=leaked replay=${message.replay}`);
		process.exit(2);
	}
	if (message.denial === "ok" && message.replay === "uuid-match") {
		console.log(`ACCEPTED denial=${message.denial} orphan=none replay=${message.replay}`);
		process.exit(0);
	}
	const failing = [
		message.denial !== "ok" ? `denial=${message.denial}` : null,
		message.replay !== "uuid-match" ? `replay=${message.replay}` : null,
	].filter(Boolean);
	console.error(`REJECTED signal=${failing.join(",") || "unknown"} orphan=none`);
	process.exit(2);
}

if (process.argv.includes(WORKER_ARGUMENT)) await runWorker();
else await runSupervisor();
