// Worker-safe entry: the built-in bash, read, write and edit tools with the exact names, schemas, descriptions and
// output shaping of a local session, running every effect through an injected ToolMachine. Nothing reachable from
// here may import a Node builtin (test/tools-core/worker-bundle.test.ts).
export type {
	ExecRequest as MachineExecRequest,
	ExecResult as MachineExecResult,
	ExecShell as MachineExecShell,
	MachineOps,
	OpContext,
} from "@code-yeongyu/senpi-machine-ops";
export { type CoreBashToolOptions, createCoreBashTool, createCoreBashToolDefinition } from "./core/tools/bash-core.ts";
export type { BashToolDetails, BashToolInput, BashToolOutput } from "./core/tools/bash-schema.ts";
export { type CoreCodingToolsOptions, createCoreCodingTools } from "./core/tools/coding-tools-core.ts";
export {
	type CoreEditToolOptions,
	createCoreEditTool,
	createCoreEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
} from "./core/tools/edit-core.ts";
export type { FileMutationQueue, ToolPathCanonicalizer, ToolPathResolver } from "./core/tools/file-tool-host.ts";
export { createMachineOutputSpill } from "./core/tools/machine-output-spill.ts";
export type { FullOutput, OutputSpill, OutputSpillFactory } from "./core/tools/output-accumulator-core.ts";
export {
	type CoreReadToolOptions,
	createCoreReadTool,
	createCoreReadToolDefinition,
	type ReadImageProcessor,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
} from "./core/tools/read-core.ts";
export {
	type BashOperations,
	createShellOperations,
	machineShellExecHost,
	type ShellExecHost,
} from "./core/tools/shell-operations.ts";
export { createToolMachine, type ToolMachine, type ToolPathPolicy } from "./core/tools/tool-machine.ts";
export {
	type CoreWriteToolOptions,
	createCoreWriteTool,
	createCoreWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
} from "./core/tools/write-core.ts";
export type { WriteToolDetails } from "./core/tools/write-result.ts";
