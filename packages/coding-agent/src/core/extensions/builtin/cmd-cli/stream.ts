import { type ChildProcessByStdio, spawn as nodeSpawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
} from "@earendil-works/pi-ai";
import { type CmdCliExecutableDeps, defaultCmdCliExecutableDeps, resolveCmdCliExecutable } from "./executable.ts";
import { buildCmdCliArgs } from "./spawn-args.ts";
import { type CmdCliResultEvent, CmdCliStreamParser } from "./stream-parser.ts";

/**
 * cmd executes its own tools; senpi does not execute them. Do not pretend otherwise in code or comments.
 */

const DEFAULT_ABORT_GRACE_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1024;

export class CmdCliProcessExitError extends Error {
	readonly kind = "process_exit" as const;
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(exitCode: number | null, stderr: string) {
		const message =
			stderr.length > 0
				? `Command Code CLI process exited with code ${exitCode}: ${stderr}`
				: `Command Code CLI process exited with code ${exitCode}`;
		super(message);
		this.name = "CmdCliProcessExitError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

export class CmdCliResultError extends Error {
	readonly kind = "result_error" as const;
	readonly subtype: string;

	constructor(subtype: string, message?: string) {
		super(message ?? `Command Code CLI result failed with subtype: ${subtype}`);
		this.name = "CmdCliResultError";
		this.subtype = subtype;
	}
}

export type CmdCliStreamDeps = {
	readonly resolveExecutable?: (deps?: CmdCliExecutableDeps) => string;
	readonly executableDeps?: CmdCliExecutableDeps;
	readonly spawn?: typeof nodeSpawn;
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly abortGraceMs?: number;
};

function blockText(blocks: readonly unknown[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.length > 0) {
			parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

function contentText(content: string | readonly unknown[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown };
		if (candidate.type === "image") {
			parts.push("[image omitted: not supported by this provider]");
		} else {
			const text = blockText([block]);
			if (text.length > 0) parts.push(text);
		}
	}
	return parts.join("\n");
}

function transcriptEntry(message: Context["messages"][number]): string {
	switch (message.role) {
		case "user":
			return `User: ${contentText(message.content)}`;
		case "assistant": {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text.length > 0) parts.push(block.text);
				if (block.type === "toolCall") parts.push(`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`);
			}
			return `Assistant: ${parts.join("\n")}`;
		}
		case "toolResult":
			return `Tool result (${message.toolName}): ${contentText(message.content)}`;
		default:
			return "";
	}
}

/**
 * Flattens senpi context into the single prompt of one fresh `cmd` run, which has no other access to it.
 * Trailing user messages are the request; the system prompt and earlier turns precede it as labeled sections.
 */
export function flattenContextPrompt(context: Context): string {
	let firstTrailing = context.messages.length;
	while (firstTrailing > 0 && context.messages[firstTrailing - 1]?.role === "user") firstTrailing -= 1;

	const request = context.messages
		.slice(firstTrailing)
		.map((message) => contentText(message.content as string | readonly unknown[]))
		.filter((text) => text.length > 0)
		.join("\n\n");
	const transcript = context.messages.slice(0, firstTrailing).map(transcriptEntry).filter(Boolean).join("\n\n");

	if (!context.systemPrompt && transcript.length === 0) return request;

	const sections: string[] = [];
	if (context.systemPrompt) sections.push(`<system_instructions>\n${context.systemPrompt}\n</system_instructions>`);
	if (transcript.length > 0) sections.push(`<conversation_so_far>\n${transcript}\n</conversation_so_far>`);
	sections.push(request.length > 0 ? request : "Continue from the conversation above.");
	return sections.join("\n\n");
}

function normalizeStopReason(reason?: string): Extract<StopReason, "stop" | "length" | "toolUse" | "deferred"> {
	switch (reason) {
		case "max_tokens":
		case "length":
			return "length";
		case "toolUse":
		case "tool_use":
			return "toolUse";
		case "deferred":
			return "deferred";
		default:
			return "stop";
	}
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid || pid <= 0) return;
	try {
		if (process.platform === "win32") {
			process.kill(pid, signal);
		} else {
			process.kill(-pid, signal);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			// Ignore ESRCH: process or process group already terminated
		}
	}
}

function emptyAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Streams Command Code CLI output to an AssistantMessageEventStream.
 * cmd executes its own tools; senpi does not execute them. Do not pretend otherwise in code or comments.
 */
export function streamCmdCli(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	deps: CmdCliStreamDeps = {},
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const signal = options?.signal;

	void (async () => {
		if (signal?.aborted) {
			stream.fail(new Error("Command Code CLI invocation was aborted"));
			return;
		}

		let executable: string;
		try {
			const resolver = deps.resolveExecutable ?? resolveCmdCliExecutable;
			executable = resolver(deps.executableDeps ?? defaultCmdCliExecutableDeps());
		} catch (error) {
			stream.fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const prompt = flattenContextPrompt(context);
		const args = buildCmdCliArgs({
			model: model.id,
		});

		const spawnFn = deps.spawn ?? nodeSpawn;
		const cwd = deps.cwd ?? process.cwd();
		const env = deps.env ?? process.env;
		const abortGraceMs = deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;

		let child: ChildProcessByStdio<Writable, Readable, Readable>;
		try {
			child = spawnFn(executable, args, {
				cwd,
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				env,
			}) as ChildProcessByStdio<Writable, Readable, Readable>;
		} catch (error) {
			stream.fail(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const output = emptyAssistantMessage(model);
		const parser = new CmdCliStreamParser();
		let started = false;
		let openIndex = -1;
		let resultError: CmdCliResultError | undefined;
		let resultSeen = false;
		let malformedMessage: string | undefined;
		let stderrBuffer: Buffer = Buffer.alloc(0);
		let abortRequested = false;
		let abortTimer: NodeJS.Timeout | undefined;

		const ensureStarted = (): void => {
			if (started) return;
			started = true;
			stream.push({ type: "start", partial: output });
		};

		const ensureTextOpen = (): void => {
			ensureStarted();
			if (openIndex >= 0) return;
			output.content.push({ type: "text", text: "" });
			openIndex = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: openIndex, partial: output });
		};

		const closeTextOpen = (): void => {
			if (openIndex < 0) return;
			const block = output.content[openIndex] as TextContent;
			stream.push({
				type: "text_end",
				contentIndex: openIndex,
				content: block.text,
				partial: output,
			});
			openIndex = -1;
		};

		const onAbort = (): void => {
			if (abortRequested) return;
			abortRequested = true;
			killProcessGroup(child.pid, "SIGTERM");
			abortTimer = setTimeout(() => {
				killProcessGroup(child.pid, "SIGKILL");
			}, abortGraceMs);
			abortTimer.unref?.();
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		const handleEvent = (event: ReturnType<CmdCliStreamParser["push"]>[number]): void => {
			if (event.type === "event" && event.event.type === "text_delta") {
				const delta = event.event.delta;
				if (delta && delta.length > 0) {
					ensureTextOpen();
					const block = output.content[openIndex] as TextContent;
					block.text += delta;
					stream.push({
						type: "text_delta",
						contentIndex: openIndex,
						delta,
						partial: output,
					});
				}
			} else if (event.type === "malformed_stream") {
				malformedMessage ??= event.message;
			} else if (event.type === "result") {
				resultSeen = true;
				const res = event as CmdCliResultEvent;
				if (res.subtype !== "success") {
					resultError = new CmdCliResultError(res.subtype ?? "unknown");
				}
				const usage = res.usage;
				const inputTokens = usage?.inputTokens ?? 0;
				const outputTokens = usage?.outputTokens ?? 0;
				const cacheReadTokens = usage?.cacheReadTokens ?? 0;
				const cacheWriteTokens = usage?.cacheWriteTokens ?? 0;
				output.usage.input = inputTokens;
				output.usage.output = outputTokens;
				output.usage.cacheRead = cacheReadTokens;
				output.usage.cacheWrite = cacheWriteTokens;
				output.usage.totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
				output.usage.cost = calculateCost(model, output.usage);
				const normalizedReason = normalizeStopReason(res.stopReason);
				output.stopReason = normalizedReason;
				if (res.stopReason) {
					output.rawStopReason = res.stopReason;
				}
				if (openIndex < 0 && res.finalText && res.finalText.length > 0) {
					ensureTextOpen();
					const block = output.content[openIndex] as TextContent;
					block.text = res.finalText;
					stream.push({
						type: "text_delta",
						contentIndex: openIndex,
						delta: res.finalText,
						partial: output,
					});
				}
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			for (const event of parser.push(chunk)) {
				handleEvent(event);
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrBuffer.length + chunk.length > MAX_STDERR_BYTES) {
				stderrBuffer = Buffer.concat([stderrBuffer, chunk]).subarray(-MAX_STDERR_BYTES);
			} else {
				stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
			}
		});

		// A worker that exits without reading stdin surfaces through its exit code, not as a write failure.
		child.stdin.once("error", () => {});
		child.stdin.end(prompt);

		child.once("error", (error) => {
			if (abortTimer) clearTimeout(abortTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			stream.fail(error);
		});

		child.once("close", (exitCode) => {
			if (abortTimer) clearTimeout(abortTimer);
			if (signal) signal.removeEventListener("abort", onAbort);

			for (const event of parser.finish()) {
				handleEvent(event);
			}

			if (abortRequested) {
				// The leader is gone but descendants that ignored SIGTERM may remain in its group.
				killProcessGroup(child.pid, "SIGKILL");
				stream.fail(new Error("Command Code CLI invocation was aborted"));
				return;
			}

			if (resultError) {
				stream.fail(resultError);
				return;
			}

			if (exitCode !== 0) {
				const stderrText = stderrBuffer.toString("utf8").trim();
				stream.fail(new CmdCliProcessExitError(exitCode, stderrText));
				return;
			}

			if (!resultSeen) {
				stream.fail(
					new CmdCliResultError(
						"malformed_stream",
						malformedMessage ?? "Command Code CLI exited without a result line",
					),
				);
				return;
			}

			ensureStarted();
			closeTextOpen();
			const doneReason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred"> =
				output.stopReason === "length" || output.stopReason === "toolUse" || output.stopReason === "deferred"
					? output.stopReason
					: "stop";
			stream.push({
				type: "done",
				reason: doneReason,
				message: output,
			});
		});
	})();

	return stream;
}
