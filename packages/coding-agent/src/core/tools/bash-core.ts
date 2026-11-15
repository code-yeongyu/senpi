import type { ExecShell } from "@code-yeongyu/senpi-machine-ops";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ShellTrust } from "../../engine-trust/shell-trust.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolOutput,
	bashOutputSchema,
	bashSchema,
	bashToolConfig,
	type ShellToolConfig,
} from "./bash-schema.ts";
import { createMachineOutputSpill } from "./machine-output-spill.ts";
import { OutputAccumulator, type OutputSpillFactory } from "./output-accumulator-core.ts";
import { createShellOutput } from "./shell-output.ts";
import { type BashOperations, createShellOperations, machineShellExecHost } from "./shell-operations.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import type { ToolMachine } from "./tool-machine.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/** Annotates a failed command's result with the engine trust status; undefined leaves the result as is. */
export type ShellTrustAnnotator = (result: {
	exitCode: number;
	output: string;
}) => { text: string | undefined; trust: ShellTrust } | undefined;

export interface ShellToolCoreOptions {
	/** Runs the policy gate once per call. */
	machine: ToolMachine;
	/** Where the command runs. */
	operations: BashOperations;
	/** Where output past the display limits is kept; the path appears in the model's truncation notice. */
	outputSpill: OutputSpillFactory;
	/** The base environment before the session's `PI_*` values. Default: empty. */
	shellEnv?: () => NodeJS.ProcessEnv;
	/** Default: no annotation. */
	annotateTrust?: ShellTrustAnnotator;
	/** Redact credential-shaped output before streaming or spilling. Default: false. */
	redactSecretsInOutput?: boolean;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

function resolveSpawnContext(
	command: string,
	cwd: string,
	baseEnv: NodeJS.ProcessEnv,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...baseEnv };
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

const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

/** A shell tool's model-facing definition and execution, without renderers: the shared core of bash and powershell. */
export function createShellToolCore(
	cwd: string,
	config: ShellToolConfig,
	options: ShellToolCoreOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const { machine, operations: ops, commandPrefix, spawnHook, annotateTrust } = options;
	const exposeSessionEnvironment = options.exposeSessionEnvironment ?? true;
	const redactSecretsInOutput = options.redactSecretsInOutput === true;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		fullPromptGuidelines:
			exposeSessionEnvironment && config.fullPromptGuidelines ? [...config.fullPromptGuidelines] : undefined,
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
			const admitted = machine.begin("process.exec", { command, timeout }, signal);
			if (admitted !== undefined) await admitted;
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				options.shellEnv?.() ?? {},
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix, spill: options.outputSpill });
			const shellOutput = createShellOutput(output, onUpdate, redactSecretsInOutput);
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}
			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: shellOutput.handleData,
						redactSecretsInOutput,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					let snapshot: Awaited<ReturnType<typeof shellOutput.finishOutput>>;
					try {
						snapshot = await shellOutput.finishOutput();
					} catch (cleanupError) {
						throw new AggregateError([err, cleanupError], "Bash command and output cleanup failed");
					}
					const { text } = shellOutput.formatOutput(snapshot, "");
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

				const snapshot = await shellOutput.finishOutput();
				const { text: outputText, content, details } = shellOutput.formatOutput(snapshot);
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
					const annotation = annotateTrust?.({ exitCode, output: fullOutput.content });
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
				shellOutput.clearUpdateTimer();
			}
		},
	};
}

export interface CoreBashToolOptions extends Omit<
	ShellToolCoreOptions,
	"operations" | "outputSpill" | "annotateTrust" | "shellEnv"
> {
	/** Where the command runs. Default: `process.exec` on `machine`, in `shell`. */
	operations?: BashOperations;
	/** The shell for the default operations. Default: the machine's own (`/bin/sh -c` on POSIX). */
	shell?: ExecShell;
	/** Default: a file under `/tmp` on `machine` (see `createMachineOutputSpill`). */
	outputSpill?: OutputSpillFactory;
}

/** The bash tool for a host whose only effect channel is `machine`. */
export function createCoreBashToolDefinition(
	cwd: string,
	options: CoreBashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const { machine } = options;
	return {
		...createShellToolCore(cwd, bashToolConfig, {
			...options,
			operations:
				options.operations ?? createShellOperations("bash", machine, machineShellExecHost(machine, options.shell)),
			outputSpill: options.outputSpill ?? createMachineOutputSpill(machine),
		}),
		exposure: "eval",
	};
}

export function createCoreBashTool(cwd: string, options: CoreBashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createCoreBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
