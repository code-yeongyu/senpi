import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	AGENT_TYPE_ENV_VAR,
	DEPTH_ENV_VAR,
	MAX_SUBAGENT_DEPTH,
	type SpawnEvent,
	type SpawnedAgent,
	type SpawnOptions,
} from "./types.js";

export type { SpawnOptions, SpawnedAgent };

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

const trackedPids = new Set<number>();

let cleanupRegistered = false;
function ensureCleanupRegistered(): void {
	if (cleanupRegistered) return;
	cleanupRegistered = true;
	process.on("exit", () => {
		for (const pid of trackedPids) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* process may already be dead */
			}
		}
	});
}

type MessagePart = { type: string; text?: string };
type NdjsonMessage = { role: string; content: MessagePart[] };

function emitSpawnEvent(options: SpawnOptions, event: SpawnEvent): void {
	options.onEvent?.(event);
}

export function spawnSubagent(options: SpawnOptions): SpawnedAgent {
	const currentDepth = parseInt(process.env[DEPTH_ENV_VAR] ?? "0", 10);
	if (currentDepth >= MAX_SUBAGENT_DEPTH) {
		throw new Error(`Maximum subagent depth (${MAX_SUBAGENT_DEPTH}) exceeded`);
	}

	const args: string[] = ["--mode", "json", "-p", options.prompt];

	if (options.model) {
		args.push("--model", options.model);
	}

	if (options.sessionPath) {
		args.push("--session", options.sessionPath);
	}

	if (options.permissionFlag) {
		args.push("--permission", options.permissionFlag);
	}

	const invocation = getPiInvocation(args);

	const childEnv: Record<string, string | undefined> = {
		...process.env,
		[DEPTH_ENV_VAR]: String(currentDepth + 1),
		...options.env,
	};

	if (options.agentType) {
		childEnv[AGENT_TYPE_ENV_VAR] = options.agentType;
	}

	const proc = spawn(invocation.command, invocation.args, {
		cwd: options.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		env: childEnv,
	});

	if (proc.pid) {
		trackedPids.add(proc.pid);
		ensureCleanupRegistered();
	}

	let buffer = "";
	const accumulatedText: string[] = [];
	const updateText: string[] = [];

	const processLine = (line: string): void => {
		if (!line.trim()) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (typeof event === "object" && event !== null && "type" in event && "message" in event) {
			const typedEvent = event as { type: string; message: NdjsonMessage };

			// Accumulate text from message_update events
			if (typedEvent.type === "message_update") {
				const message = typedEvent.message;
				if (message.role === "assistant" && Array.isArray(message.content)) {
					for (const part of message.content) {
						if (part.type === "text" && part.text) {
							updateText.push(part.text);
						}
					}
				}
			}

			// Extract final result from message_end, or fall back to accumulated update text
			if (typedEvent.type === "message_end") {
				const message = typedEvent.message;
				if (message.role === "assistant" && Array.isArray(message.content)) {
					const endText: string[] = [];
					for (const part of message.content) {
						if (part.type === "text" && part.text) {
							endText.push(part.text);
						}
					}
					if (endText.length > 0) {
						// message_end has the final text - use it
						accumulatedText.length = 0;
						accumulatedText.push(...endText);
					} else if (updateText.length > 0) {
						// Fall back to accumulated update text
						accumulatedText.length = 0;
						accumulatedText.push(...updateText);
					}
				}
			}
		}

		if (
			typeof event === "object" &&
			event !== null &&
			"type" in event &&
			"toolCallId" in event &&
			"toolName" in event
		) {
			const typedEvent = event as {
				type: string;
				toolCallId: unknown;
				toolName: unknown;
			};

			if (typeof typedEvent.toolCallId !== "string" || typeof typedEvent.toolName !== "string") {
				return;
			}

			if (typedEvent.type === "tool_execution_start") {
				emitSpawnEvent(options, {
					type: "tool_execution_start",
					toolCallId: typedEvent.toolCallId,
					toolName: typedEvent.toolName,
				});
			}

			if (typedEvent.type === "tool_execution_end") {
				emitSpawnEvent(options, {
					type: "tool_execution_end",
					toolCallId: typedEvent.toolCallId,
					toolName: typedEvent.toolName,
				});
			}
		}
	};

	proc.stdout.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			processLine(line);
		}
	});

	if (options.signal) {
		const killProc = (): void => {
			if (proc.pid) {
				try {
					proc.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				setTimeout(() => {
					if (!proc.killed && proc.pid) {
						try {
							proc.kill("SIGKILL");
						} catch {
							/* ignore */
						}
					}
				}, 5000);
			}
		};

		if (options.signal.aborted) {
			killProc();
		} else {
			options.signal.addEventListener("abort", killProc, { once: true });
		}
	}

	const result = new Promise<{ text: string; exitCode: number }>((resolve) => {
		proc.on("close", (code) => {
			if (buffer.trim()) {
				processLine(buffer);
			}

			if (proc.pid) {
				trackedPids.delete(proc.pid);
			}

			resolve({
				text: accumulatedText.join(""),
				exitCode: code ?? 0,
			});
		});

		proc.on("error", () => {
			if (proc.pid) {
				trackedPids.delete(proc.pid);
			}
			resolve({
				text: accumulatedText.join(""),
				exitCode: 1,
			});
		});
	});

	return { process: proc, result };
}
