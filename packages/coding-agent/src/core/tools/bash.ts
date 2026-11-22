import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { annotateShellTrust } from "../../engine-trust/shell-trust.ts";
import {
	getShellConfig,
	getShellEnv,
	noteDetachedChildExited,
	pruneTrackedDetachedChildren,
	type ShellConfig,
	trackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { attestSessionSpawn } from "../session-spawn-attestation.ts";
import { createShellToolCore } from "./bash-core.ts";
import {
	type BashSpawnHook,
	type BashToolDetails,
	type bashSchema,
	bashToolConfig,
	type ShellToolConfig,
} from "./bash-schema.ts";
import { defaultToolMachine, type ToolMachine } from "./machine.ts";
import { createTempFileSpill } from "./output-accumulator.ts";
import { mapWindowsNulRedirects } from "./windows-nul-redirect.ts";
import { createShellRenderers } from "./renderers/bash.ts";
import { type BashOperations, createShellOperations } from "./shell-operations.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export {
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOutput,
	bashToolSystemPromptContribution,
	type ShellToolConfig,
} from "./bash-schema.ts";
export type { BashOperations } from "./shell-operations.ts";

/**
 * Shared process execution used by the built-in shell tools: one `process.exec` of the operation layer (own
 * process group, scope token, abort/timeout kill the group). The tool keeps its own output handling.
 */
export function createLocalShellOperations(
	shellName: string,
	resolveShellConfig: () => ShellConfig,
	machine: ToolMachine = defaultToolMachine(),
): BashOperations {
	return createShellOperations(shellName, machine, {
		resolveShell: () => {
			const shellConfig = resolveShellConfig();
			return {
				path: shellConfig.shell,
				args: shellConfig.args,
				commandTransport: shellConfig.commandTransport === "stdin" ? "stdin" : "argv",
			};
		},
		checkCwd: (cwd) => fsAccess(cwd, constants.F_OK),
		envMode: "exact",
		defaultEnv: getShellEnv,
		signalNumber: (signal) => osConstants.signals[signal as NodeJS.Signals],
		// Tracked as a process group: whatever the shell backgrounds keeps running in it, and ownership
		// is released only once that group is empty (senpi#1697).
		onSpawn: trackDetachedChildPid,
		onExit: noteDetachedChildExited,
		attestSessionSpawn,
		// Groups kept past their shell's exit must not accumulate across a session.
		afterExec: pruneTrackedDetachedChildren,
	});
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string; machine?: ToolMachine }): BashOperations {
	const operations = createLocalShellOperations("bash", () => getShellConfig(options?.shellPath), options?.machine);
	if (process.platform !== "win32") return operations;
	// Git Bash turns a cmd.exe-style `>nul` into a literal `nul` file (senpi#3765).
	return {
		...operations,
		exec: (command, cwd, execOptions) => operations.exec(mapWindowsNulRedirects(command), cwd, execOptions),
	};
}

/** A tool routed to the session's device by OMO_TOOLS_VIA_DAEMON found no device to run on; it never falls back to local. */
export class DeviceUnavailableError extends Error {
	readonly code = "device_unavailable" as const;
	readonly tool: string;
	constructor(tool: string) {
		super(
			`${tool}: the session's device is unavailable, and OMO_TOOLS_VIA_DAEMON routes ${tool} there, so it does not run locally`,
		);
		this.name = "DeviceUnavailableError";
		this.tool = tool;
	}
}

const toolsViaDaemon = (tool: string, env: NodeJS.ProcessEnv = process.env): boolean =>
	(env.OMO_TOOLS_VIA_DAEMON ?? "")
		.split(",")
		.map((name) => name.trim())
		.includes(tool);

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
	/**
	 * The operation layer of the device this session works on. Slice 1a of the tools-via-daemon plan: an executor seam
	 * only, NOT yet via the daemon; the relay transport that supplies it is slice 1b. Used only when OMO_TOOLS_VIA_DAEMON
	 * names "bash"; with the flag on and no device machine, a call fails with DeviceUnavailableError and never runs locally.
	 */
	deviceMachine?: ToolMachine | (() => ToolMachine | undefined);
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const machine = options?.machine ?? defaultToolMachine();
	// OMO_TOOLS_VIA_DAEMON=bash (default off): run on the session's device, never on this machine. The flag decides even
	// when the session injects its dispatcher's operations (bootstrap.ts always does), so the promise holds in a real session.
	// Only the bash tool: powershell shares this definition with its own local operations and stays on them.
	const viaDevice = config.name === "bash" && toolsViaDaemon("bash");
	const deviceMachine = options?.deviceMachine;
	// Resolved when the command runs, not when the tool is built: an extension may register the device later.
	const resolveDevice = typeof deviceMachine === "function" ? deviceMachine : () => deviceMachine;
	const ops: BashOperations = viaDevice
		? {
				exec: (command, execCwd, execOptions) => {
					const device = resolveDevice();
					if (device === undefined) throw new DeviceUnavailableError(config.name);
					return createLocalBashOperations({ shellPath: options?.shellPath, machine: device }).exec(
						command,
						execCwd,
						execOptions,
					);
				},
			}
		: (options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath, machine }));
	return {
		...(options?.operations !== undefined || options?.spawnHook !== undefined ? { serverPinned: true } : {}),
		...createShellToolCore(cwd, config, {
			machine,
			operations: ops,
			outputSpill: createTempFileSpill,
			shellEnv: getShellEnv,
			annotateTrust: annotateShellTrust,
			redactSecretsInOutput: options?.redactSecretsInOutput,
			commandPrefix: options?.commandPrefix,
			exposeSessionEnvironment: options?.exposeSessionEnvironment,
			spawnHook: options?.spawnHook,
		}),
		...createShellRenderers(config.prompt),
	};
}

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
