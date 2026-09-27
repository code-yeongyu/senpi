/**
 * Muse Code subscription turns run through the official `muse` CLI.
 *
 * Meta's subscription credential is valid only inside the Muse Code harness, so
 * this API never reads, mints, or sends a Meta credential. It hands the
 * conversation to `muse exec --json`, which owns sign-in, model requests, and
 * its own agent tools, and relays the streamed answer. Node-only: reached through
 * `muse-code-cli.lazy.ts` so the package root stays browser-safe.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";

export class MuseSidecarError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MuseSidecarError";
	}
}

export interface MuseRunRequest {
	readonly model: string;
	readonly prompt: string;
	readonly reasoning: string;
	readonly workspace: string;
	readonly allowTools: boolean;
	readonly signal?: AbortSignal;
	readonly binary?: string;
	/** The echo provider exercises the real CLI without a network request. */
	readonly provider?: "meta" | "echo";
}

export async function runMuse(request: MuseRunRequest, onText: (delta: string) => void): Promise<string> {
	request.signal?.throwIfAborted();
	const directory = await mkdtemp(join(tmpdir(), "senpi-muse-"));
	const promptFile = join(directory, "prompt.txt");
	try {
		await writeFile(promptFile, request.prompt, { mode: 0o600 });
		const args = [
			"exec",
			"--json",
			"--workspace",
			request.workspace,
			"--prompt-file",
			promptFile,
			"--user-input-auto-resolve",
		];
		if (request.provider === "echo") args.push("--provider", "echo", "--no-session-log");
		else args.push("--model", request.model, "--reasoning-effort", request.reasoning);
		if (!request.allowTools) args.push("--disable-shell", "--disable-write");

		// Muse, not this extension, owns authentication. A parent API key must
		// not silently override the CLI's subscription sign-in.
		const childEnv = { ...process.env };
		delete childEnv.META_API_KEY;
		const child = spawn(request.binary ?? "muse", args, {
			cwd: request.workspace,
			detached: process.platform !== "win32",
			env: childEnv,
			signal: request.signal,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		let stderr = "";
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-8192);
		});

		const exit = new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? 1));
		});
		void exit.catch(() => {});
		let streamed = "";
		let terminal: { status: string; text: string; reason: string | null } | undefined;
		try {
			let pending = "";
			readOutput: for await (const chunk of child.stdout) {
				pending += String(chunk);
				let end = pending.indexOf("\n");
				while (end !== -1) {
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					if (line.length > 0) {
						const event: unknown = JSON.parse(line);
						if (event && typeof event === "object" && "payload" in event) {
							const payload = event.payload;
							if (payload && typeof payload === "object" && "kind" in payload) {
								switch (payload.kind) {
									case "run_output_delta":
										if ("text" in payload && typeof payload.text === "string") {
											streamed += payload.text;
											onText(payload.text);
										}
										break;
									case "run_terminal":
										if ("terminal" in payload && typeof payload.terminal === "string") {
											terminal = {
												status: payload.terminal,
												text: "text" in payload && typeof payload.text === "string" ? payload.text : "",
												reason:
													"reason" in payload && typeof payload.reason === "string"
														? payload.reason
														: null,
											};
										}
										break readOutput;
								}
							}
						}
					}
					end = pending.indexOf("\n");
				}
			}
			if (request.signal?.aborted) throw new MuseSidecarError("Muse CLI run was cancelled");
			if (!terminal && pending.trim().length > 0)
				throw new MuseSidecarError("Muse CLI ended with an incomplete JSONL event");
			if (!terminal) {
				const code = await exit;
				throw new MuseSidecarError(`Muse CLI exited ${code}: ${stderr.trim() || "missing run terminal"}`);
			}
			if (terminal.status !== "completed") {
				const detail = terminal?.reason || stderr.trim() || "missing run terminal";
				throw new MuseSidecarError(`Muse CLI did not complete: ${detail}`);
			}
			if (terminal.text.startsWith(streamed)) onText(terminal.text.slice(streamed.length));
			return terminal.text;
		} finally {
			// A finished Muse run can leave reminder descendants holding stdout
			// open. The terminal event, not pipe EOF, is the completion signal.
			if (child.exitCode === null && process.platform !== "win32" && child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			} else if (child.exitCode === null) {
				child.kill("SIGTERM");
			}
			child.stdout.destroy();
			child.stderr.destroy();
			await exit.catch(() => {});
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function partText(part: Exclude<Context["messages"][number]["content"], string>[number]): string | undefined {
	if (part.type === "text") return part.text;
	if (part.type === "toolCall") return `Tool call ${part.name}: ${JSON.stringify(part.arguments)}`;
	return undefined;
}

function promptFor(context: Context): string {
	const messages = context.messages.map((message) => {
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.map(partText)
						.filter((text) => text !== undefined)
						.join("\n");
		if (message.role === "user") return `User:\n${content}`;
		if (message.role === "assistant") return `Assistant:\n${content}`;
		if (message.role === "toolResult")
			return `Tool result (${message.toolName}${message.isError ? ", error" : ""}):\n${content}`;
		return `Configuration update:\n${content}`;
	});
	return [context.systemPrompt && `Instructions:\n${context.systemPrompt}`, ...messages].filter(Boolean).join("\n\n");
}

function streamMuse(model: Model<"muse-code-cli">, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
	void (async () => {
		try {
			stream.push({ type: "start", partial: output });
			let text: { type: "text"; text: string } | undefined;
			const finalText = await runMuse(
				{
					model: model.id,
					prompt: promptFor(context),
					reasoning: options?.thinkingSelection?.level === "off" ? "none" : (options?.reasoning ?? "low"),
					workspace: process.cwd(),
					allowTools: options?.streamKind === "main" && (context.tools?.length ?? 0) > 0,
					...(options?.signal ? { signal: options.signal } : {}),
				},
				(delta) => {
					if (!delta) return;
					if (!text) {
						text = { type: "text", text: "" };
						output.content.push(text);
						stream.push({ type: "text_start", contentIndex: 0, partial: output });
					}
					text.text += delta;
					stream.push({ type: "text_delta", contentIndex: 0, delta, partial: output });
				},
			);
			if (text) {
				text.text = finalText;
				stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: output });
			}
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end();
		}
	})();
	return stream;
}

export const stream: StreamFunction<"muse-code-cli", SimpleStreamOptions> = streamMuse;
export const streamSimple: StreamFunction<"muse-code-cli", SimpleStreamOptions> = streamMuse;
