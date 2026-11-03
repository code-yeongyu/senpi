// allow: SIZE_OK - pre-existing cohesive shell integration; this patch only hardens its output-finalization seam.
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { ExecShell } from "@code-yeongyu/senpi-machine-ops";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { annotateShellTrust, type ShellTrust } from "../../engine-trust/shell-trust.ts";
import {
	getShellConfig,
	getShellEnv,
	noteDetachedChildExited,
	pruneTrackedDetachedChildren,
	type ShellConfig,
	trackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { defaultToolMachine, type ToolMachine } from "./machine.ts";
import { modelOnlyText } from "./model-only-text.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { SecretOutputRedactor } from "./secret-output-redactor.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, rg, find, etc.)",
	guidelines: ["PI_* env vars = current model + session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({
		description:
			"Combined stdout and stderr, up to 1 MiB. Longer output keeps its first and last 512 KiB around an omission marker.",
	}),
	truncated: Type.Boolean({ description: "Whether `output` omits part of the command output" }),
	full_output_path: Type.Optional(Type.String({ description: "Temp file with the full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	trust?: ShellTrust;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer, stream?: "stdout" | "stderr") => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			redactSecretsInOutput?: boolean;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Shared process execution used by the built-in shell tools: one `process.exec` of the operation layer (own
 * process group, scope token, abort/timeout kill the group). The tool keeps its own output handling.
 */
export function createLocalShellOperations(
	shellName: string,
	resolveShellConfig: () => ShellConfig,
	machine: ToolMachine = defaultToolMachine(),
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			let streamCallbackError: unknown;
			let hasStreamCallbackError = false;
			// A failing output callback stops the command the same way an abort does.
			const callbackAbort = new AbortController();
			const failStream = (error: unknown) => {
				if (hasStreamCallbackError) return;
				streamCallbackError = error;
				hasStreamCallbackError = true;
				callbackAbort.abort();
			};
			const handleData = (data: Buffer, stream: "stdout" | "stderr") => {
				if (hasStreamCallbackError) return;
				try {
					const callbackResult = (onData as (data: Buffer, stream: "stdout" | "stderr") => unknown)(data, stream);
					if (callbackResult && typeof (callbackResult as { then?: unknown }).then === "function") {
						void Promise.resolve(callbackResult).catch(failStream);
					}
				} catch (error) {
					failStream(error);
				}
			};
			const shell: ExecShell = {
				path: shellConfig.shell,
				args: shellConfig.args,
				commandTransport: shellConfig.commandTransport === "stdin" ? "stdin" : "argv",
			};
			const execSignal = signal ? AbortSignal.any([signal, callbackAbort.signal]) : callbackAbort.signal;
			let result: Awaited<ReturnType<typeof machine.ops.process.exec>>;
			try {
				result = await machine.ops.process.exec(
					{
						command,
						cwd,
						env: env ?? getShellEnv(),
						envMode: "exact",
						shell,
						timeoutMs: timeoutMs ?? Number.POSITIVE_INFINITY,
						onOutput: handleData,
						// Tracked as a process group: whatever the shell backgrounds keeps running in it, and ownership
						// is released only once that group is empty (senpi#1697).
						onSpawn: trackDetachedChildPid,
						onExit: noteDetachedChildExited,
					},
					machine.context(execSignal),
				);
			} catch (error) {
				if (hasStreamCallbackError) throw streamCallbackError;
				if (signal?.aborted) throw new Error("aborted");
				throw error;
			} finally {
				// Groups kept past their shell's exit must not accumulate across a session.
				pruneTrackedDetachedChildren();
			}
			if (hasStreamCallbackError) {
				throw streamCallbackError;
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			if (result.timedOut) {
				throw new Error(`timeout:${timeout}`);
			}
			// A signal-killed shell has no exit code. Use the standard shell convention so
			// callers do not mistake the termination for a successful command.
			return {
				exitCode:
					result.exitCode ??
					(result.signal ? 128 + (osConstants.signals[result.signal as NodeJS.Signals] ?? 0) : 1),
			};
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string; machine?: ToolMachine }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath), options?.machine);
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_SESSION_CWD;
	delete env.PI_GOAL_STORE_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	delete env.OMO_BROWSER_ENGINE;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		env.PI_SESSION_CWD = ctx.cwd;
		if (ctx.goalStoreFile) env.PI_GOAL_STORE_FILE = ctx.goalStoreFile;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
		if (ctx.browserEngine) env.OMO_BROWSER_ENGINE = ctx.browserEngine;
		Object.assign(env, ctx.sessionEnv);
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Redact credential-shaped output before streaming or spilling. Default: false. */
	redactSecretsInOutput?: boolean;
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/** Operation layer and policy gate. Default: the process-wide local machine. */
	machine?: ToolMachine;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const machine = options?.machine ?? defaultToolMachine();
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath, machine });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		...(options?.operations !== undefined || spawnHook !== undefined ? { serverPinned: true } : {}),
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			await machine.begin("process.exec", { command, timeout }, signal);
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			const streams =
				options?.redactSecretsInOutput === true
					? new Map<string, { redactor: SecretOutputRedactor; decoder: TextDecoder }>()
					: undefined;
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;
			let outputUpdateError: unknown;
			let hasOutputUpdateError = false;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty || hasOutputUpdateError) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				try {
					onUpdate({
						content: [{ type: "text", text: snapshot.content || "" }],
						details: {
							truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
							fullOutputPath: snapshot.fullOutputPath,
						},
					});
				} catch (error) {
					outputUpdateError = error;
					hasOutputUpdateError = true;
				}
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer, stream = "stdout") => {
				if (!acceptingOutput) return;
				if (streams) {
					let state = streams.get(stream);
					if (!state) {
						state = { redactor: new SecretOutputRedactor(), decoder: new TextDecoder() };
						streams.set(stream, state);
					}
					output.appendText(state.redactor.push(state.decoder.decode(data, { stream: true })));
				} else output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				clearUpdateTimer();
				let primaryError: unknown;
				let hasPrimaryError = false;
				let snapshot: Awaited<ReturnType<OutputAccumulator["snapshot"]>> | undefined;
				try {
					if (streams) {
						for (const { redactor, decoder } of streams.values()) {
							output.appendText(redactor.push(decoder.decode()) + redactor.finish());
						}
						updateDirty = true;
					}
					output.finish();
					emitOutputUpdate();
					snapshot = output.snapshot({ persistIfTruncated: true });
					if (hasOutputUpdateError) {
						primaryError = outputUpdateError;
						hasPrimaryError = true;
					}
				} catch (error) {
					primaryError = error;
					hasPrimaryError = true;
				}
				try {
					await output.closeTempFile();
				} catch (closeError) {
					if (hasPrimaryError) {
						throw new AggregateError(
							[primaryError, closeError],
							"Bash output finalization and spill cleanup failed",
						);
					}
					throw closeError;
				}
				if (hasPrimaryError) {
					try {
						await output.removeTempFile();
					} catch (unlinkError) {
						if (!(unlinkError instanceof Error)) throw unlinkError;
						throw new AggregateError(
							[primaryError, unlinkError],
							"Bash output finalization and spill cleanup failed",
						);
					}
					throw primaryError;
				}
				if (snapshot === undefined) {
					throw new Error("Bash output finalization produced no snapshot");
				}
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				const text = snapshot.content || emptyText;
				let notice: string | undefined;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						notice = `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				const content: TextContent[] = [{ type: "text", text: notice === undefined ? text : `${text}\n` }];
				if (notice !== undefined) content.push(modelOnlyText(notice));
				return { text: notice === undefined ? text : `${text}\n\n${notice}`, content, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						redactSecretsInOutput: options?.redactSecretsInOutput === true,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					let snapshot: Awaited<ReturnType<typeof finishOutput>>;
					try {
						snapshot = await finishOutput();
					} catch (cleanupError) {
						throw new AggregateError([err, cleanupError], "Bash command and output cleanup failed");
					}
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					try {
						await output.removeTempFile();
					} catch (unlinkError) {
						throw new AggregateError([err, unlinkError], "Bash command and output cleanup failed");
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, content, details } = formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
				};
				if (exitCode !== 0) {
					const text = appendStatus(outputText, `Command exited with code ${exitCode}`);
					// The engine trust annotation (omo#10762) rides only on error results, so the success
					// `outputSchema` (and the prompt bytes it costs) stays unchanged.
					const annotation = annotateShellTrust({ exitCode, output: fullOutput.content });
					if (annotation === undefined) {
						return { content: [{ type: "text", text }], details, structuredContent, isError: true };
					}
					return {
						content: [
							{ type: "text", text: annotation.text === undefined ? text : `${text}\n\n${annotation.text}` },
						],
						details: { ...details, trust: annotation.trust },
						structuredContent: { ...structuredContent, trust: annotation.trust },
						isError: true,
					};
				}
				// Success keeps the fork's model-only truncation notice; the error text above carries it inline.
				return { content, details, structuredContent };
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return {
		...createShellToolDefinition(cwd, bashToolConfig, options),
		exposure: "eval",
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
