#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const SESSION_ID = "fake-session-001";
const REQUEST_ID = "fake-request-001";
const MODEL = "Composer 2.5 Fast";
const ENV_ALLOWLIST = [
	"HOME",
	"PATH",
	"AGENT_CLI_CREDENTIAL_STORE",
	"TERM",
	"LANG",
	"LC_ALL",
	"FORCE_COLOR",
];

function writeEvent(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function initEvent() {
	return {
		type: "system",
		subtype: "init",
		apiKeySource: "login",
		cwd: "/tmp/fake-cursor-workspace",
		session_id: SESSION_ID,
		model: MODEL,
		permissionMode: "default",
	};
}

function assistantEvent(text, timestampMs) {
	return {
		type: "assistant",
		message: { role: "assistant", content: [{ type: "text", text }] },
		session_id: SESSION_ID,
		timestamp_ms: timestampMs,
	};
}

function resultEvent(result = "STREAMTEST OK") {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 125,
		duration_api_ms: 125,
		is_error: false,
		result,
		session_id: SESSION_ID,
		request_id: REQUEST_ID,
		usage: {
			inputTokens: 12,
			outputTokens: 7,
			cacheReadTokens: 3,
			cacheWriteTokens: 0,
		},
	};
}

function emitHappy() {
	writeEvent(initEvent());
	writeEvent({
		type: "thinking",
		subtype: "delta",
		text: "Preparing deterministic response.",
		session_id: SESSION_ID,
		timestamp_ms: 1_786_958_613_718,
	});
	writeEvent({
		type: "thinking",
		subtype: "completed",
		session_id: SESSION_ID,
		timestamp_ms: 1_786_958_613_719,
	});
	writeEvent(assistantEvent("STREAM", 1_786_958_613_720));
	writeEvent(assistantEvent("TEST OK", 1_786_958_613_721));
	writeEvent(assistantEvent("STREAMTEST OK", 1_786_958_613_722));
	writeEvent(resultEvent());
}

function emitTools() {
	const callId = "tool_fake-shell-001";
	const startedAtMs = "1786958761633";
	const args = {
		command: "echo tooltest-force-77",
		workingDirectory: "",
		timeout: 30_000,
		toolCallId: callId,
		simpleCommands: ["echo"],
		hasInputRedirect: false,
		hasOutputRedirect: false,
		fileOutputThresholdBytes: "40000",
		isBackground: false,
		skipApproval: false,
		timeoutBehavior: "TIMEOUT_BEHAVIOR_BACKGROUND",
		hardTimeout: 86_400_000,
		description: "Run echo and capture stdout",
		closeStdin: true,
		conversationId: SESSION_ID,
		adminCommandDenylist: [],
	};
	writeEvent({
		type: "tool_call",
		subtype: "started",
		call_id: callId,
		tool_call: {
			shellToolCall: { args, description: "Run echo and capture stdout" },
			hookAdditionalContexts: [],
			toolCallId: callId,
			startedAtMs,
		},
		model_call_id: "fake-model-call-001",
		session_id: SESSION_ID,
		timestamp_ms: 1_786_958_761_563,
	});
	writeEvent({
		type: "tool_call",
		subtype: "completed",
		call_id: callId,
		tool_call: {
			shellToolCall: {
				args,
				result: {
					success: {
						command: "echo tooltest-force-77",
						workingDirectory: "",
						exitCode: 0,
						signal: "",
						stdout: "tooltest-force-77\n",
						stderr: "",
						executionTime: 25,
						interleavedOutput: "tooltest-force-77\n",
						localExecutionTimeMs: 12,
					},
					isBackground: false,
				},
				description: "Run echo and capture stdout",
			},
			hookAdditionalContexts: [],
			toolCallId: callId,
			startedAtMs,
			completedAtMs: "1786958761658",
		},
		model_call_id: "fake-model-call-001",
		session_id: SESSION_ID,
		timestamp_ms: 1_786_958_761_588,
	});
}

function emitRejected() {
	const callId = "tool_fake-shell-rejected-001";
	writeEvent({
		type: "tool_call",
		subtype: "completed",
		call_id: callId,
		tool_call: {
			shellToolCall: {
				result: {
					rejected: {
						command: "echo tooltest-42",
						workingDirectory: "/tmp/fake-cursor-workspace",
						reason: "",
						isReadonly: false,
					},
				},
			},
			hookAdditionalContexts: [],
			toolCallId: callId,
			startedAtMs: "1786958737718",
			completedAtMs: "1786958738636",
		},
		model_call_id: "fake-model-call-rejected-001",
		session_id: SESSION_ID,
		timestamp_ms: 1_786_958_738_568,
	});
}

function emitMalformed() {
	writeEvent(initEvent());
	process.stdout.write('{"type":"assistant","message":');
	process.stdout.write("\n");
	writeEvent({
		type: "thinking",
		subtype: "delta",
		text: "Still valid after a truncated line.",
		session_id: SESSION_ID,
		timestamp_ms: 1_786_958_613_723,
	});
	process.stdout.write("not-json-at-all\n");
	writeEvent(resultEvent("Recovered valid result"));
}

async function emitSlow() {
	writeEvent(initEvent());
	writeEvent(assistantEvent("slow-", 1_786_958_613_730));
	await sleep(60);
	writeEvent(assistantEvent("stream-", 1_786_958_613_790));
	await sleep(90);
	writeEvent(assistantEvent("complete", 1_786_958_613_880));
	writeEvent(resultEvent("slow-stream-complete"));
}

function dumpInvocation() {
	const dumpPath = process.env.FAKE_CURSOR_ARGV_DUMP;
	if (!dumpPath) {
		throw new Error("FAKE_CURSOR_ARGV_DUMP is required");
	}
	const env = {};
	for (const name of ENV_ALLOWLIST) {
		if (process.env[name] !== undefined) {
			env[name] = process.env[name];
		}
	}
	writeFileSync(dumpPath, `${JSON.stringify({ argv: process.argv.slice(2), env }, null, 2)}\n`, "utf8");
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}

async function main() {
	dumpInvocation();
	const scenario = process.env.FAKE_CURSOR_SCENARIO ?? "happy";
	switch (scenario) {
		case "happy":
			emitHappy();
			break;
		case "tools":
			emitTools();
			break;
		case "rejected":
			emitRejected();
			break;
		case "rate_limit":
			fail("Error: rate limit exceeded. Please try again later.");
			break;
		case "invalid_model": {
			const modelIndex = process.argv.indexOf("--model");
			const modelId = modelIndex >= 0 ? process.argv[modelIndex + 1] : "fake-invalid-model";
			fail(`Invalid model value: ${modelId}`);
			break;
		}
		case "keychain_locked":
			fail("Error: Your macOS login keychain is locked.");
			break;
		case "malformed":
			emitMalformed();
			break;
		case "slow":
			await emitSlow();
			break;
		case "context_overflow":
			fail("Error: prompt exceeds the maximum context length for this model's context window.");
			break;
		case "grandchild": {
			const pidFile = process.env.FAKE_CURSOR_GRANDCHILD_PID_FILE;
			if (!pidFile) {
				throw new Error("FAKE_CURSOR_GRANDCHILD_PID_FILE is required for the grandchild scenario");
			}
			const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				stdio: "ignore",
			});
			if (!grandchild.pid) {
				throw new Error("Failed to spawn fake cursor-agent grandchild");
			}
			writeFileSync(pidFile, `${grandchild.pid}\n`, "utf8");
			grandchild.unref();
			emitHappy();
			break;
		}
		default:
			fail(`Unknown FAKE_CURSOR_SCENARIO: ${scenario}`);
	}
}

main().catch((error) => {
	fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
