export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export { createGlobTool, createGlobToolDefinition, type GlobToolOptions } from "./glob.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { MachineOps } from "@code-yeongyu/senpi-machine-ops";
import { type AgentTool, selectedReadFolder } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGlobToolDefinition, type GlobToolOptions } from "./glob.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createToolMachine, type ToolPathPolicy } from "./machine.ts";
import { createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "glob" | "ls";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"glob",
	"ls",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	glob?: GlobToolOptions;
	ls?: LsToolOptions;
	/** The one operation layer every tool calls. Default: the process-wide local machine (principal `local-session`). */
	machineOps?: MachineOps;
	/** Hooks for the tool path: only `beforeOp`, run once per tool call before any effect. */
	machinePolicy?: ToolPathPolicy;
}

function toolMachine(options: ToolsOptions | undefined) {
	return createToolMachine({ ops: options?.machineOps, policy: options?.machinePolicy });
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const machine = toolMachine(options);
	return {
		read: createReadToolDefinition(cwd, { folder: selectedReadFolder, machine, ...options?.read }),
		bash: createBashToolDefinition(cwd, { machine, ...options?.bash }),
		powershell: createPowerShellToolDefinition(cwd, { machine, ...options?.powershell }),
		edit: createEditToolDefinition(cwd, { machine, ...options?.edit }),
		write: createWriteToolDefinition(cwd, { machine, ...options?.write }),
		grep: createGrepToolDefinition(cwd, { machine, ...options?.grep }),
		find: createFindToolDefinition(cwd, { machine, ...options?.find }),
		glob: createGlobToolDefinition(cwd, { machine, ...options?.glob }),
		ls: createLsToolDefinition(cwd, { machine, ...options?.ls }),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const machine = toolMachine(options);
	return [
		createReadTool(cwd, { folder: selectedReadFolder, machine, ...options?.read }),
		createBashTool(cwd, { machine, ...options?.bash }),
		createEditTool(cwd, { machine, ...options?.edit }),
		createWriteTool(cwd, { machine, ...options?.write }),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const machine = toolMachine(options);
	return [
		createReadTool(cwd, { folder: selectedReadFolder, machine, ...options?.read }),
		createGrepTool(cwd, { machine, ...options?.grep }),
		createFindTool(cwd, { machine, ...options?.find }),
		createLsTool(cwd, { machine, ...options?.ls }),
	];
}
