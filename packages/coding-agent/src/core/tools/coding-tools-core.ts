import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type CoreBashToolOptions, createCoreBashTool } from "./bash-core.ts";
import { type CoreEditToolOptions, createCoreEditTool } from "./edit-core.ts";
import { type CoreReadToolOptions, createCoreReadTool } from "./read-core.ts";
import type { ToolMachine } from "./tool-machine.ts";
import { type CoreWriteToolOptions, createCoreWriteTool } from "./write-core.ts";

export interface CoreCodingToolsOptions {
	/** The one effect channel of all four tools. */
	machine: ToolMachine;
	read?: Omit<CoreReadToolOptions, "machine">;
	bash?: Omit<CoreBashToolOptions, "machine">;
	edit?: Omit<CoreEditToolOptions, "machine">;
	write?: Omit<CoreWriteToolOptions, "machine">;
}

/** read, bash, edit and write, in `createCodingTools` order, for a host whose only effect channel is `machine`. */
export function createCoreCodingTools(cwd: string, options: CoreCodingToolsOptions): AgentTool<any>[] {
	const { machine } = options;
	return [
		createCoreReadTool(cwd, { ...options.read, machine }),
		createCoreBashTool(cwd, { ...options.bash, machine }),
		createCoreEditTool(cwd, { ...options.edit, machine }),
		createCoreWriteTool(cwd, { ...options.write, machine }),
	];
}
