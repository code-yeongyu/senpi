import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type CoreBashToolOptions, createCoreBashTool } from "./bash-core.ts";
import type { bashSchema } from "./bash-schema.ts";
import { type CoreEditToolOptions, createCoreEditTool, type editSchema } from "./edit-core.ts";
import { type CoreReadToolOptions, createCoreReadTool, type readSchema } from "./read-core.ts";
import type { ToolMachine } from "./tool-machine.ts";
import { type CoreWriteToolOptions, createCoreWriteTool, type writeSchema } from "./write-core.ts";

export interface CoreCodingToolsOptions {
	/** The one effect channel of all four tools. */
	machine: ToolMachine;
	read?: Omit<CoreReadToolOptions, "machine">;
	bash?: Omit<CoreBashToolOptions, "machine">;
	edit?: Omit<CoreEditToolOptions, "machine">;
	write?: Omit<CoreWriteToolOptions, "machine">;
}

/** read, bash, edit and write, in `createCodingTools` order, for a host whose only effect channel is `machine`. */
export type CoreCodingTools = [
	AgentTool<typeof readSchema>,
	AgentTool<typeof bashSchema>,
	AgentTool<typeof editSchema>,
	AgentTool<typeof writeSchema>,
];

export function createCoreCodingTools(cwd: string, options: CoreCodingToolsOptions): CoreCodingTools {
	const { machine } = options;
	return [
		createCoreReadTool(cwd, { ...options.read, machine }),
		createCoreBashTool(cwd, { ...options.bash, machine }),
		createCoreEditTool(cwd, { ...options.edit, machine }),
		createCoreWriteTool(cwd, { ...options.write, machine }),
	];
}
