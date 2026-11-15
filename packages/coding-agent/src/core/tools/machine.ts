import { createLocalMachineOps, type MachineOps } from "@code-yeongyu/senpi-machine-ops";
import { createInProcessHolderLink } from "@code-yeongyu/senpi-machine-ops/in-process-holder";
import { killProcessTree } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { bindToolMachine, type ToolMachine, type ToolPathPolicy } from "./tool-machine.ts";

export type { ToolMachine, ToolPathPolicy } from "./tool-machine.ts";

let processMachineOps: MachineOps | undefined;

/**
 * The process-wide local MachineOps the built-in tools use when no caller supplies one. It has no `stateDir`, so it
 * records no scope tokens and writes nothing to disk: abort and timeout still kill the command's process group.
 */
function defaultLocalMachineOps(): MachineOps {
	processMachineOps ??= createLocalMachineOps({
		holder: createInProcessHolderLink(),
		// A call, not the bare reference: the session-path audit (no-sync-in-session-path) follows calls only, and the
		// Windows kill path behind it (`taskkill` via spawnSync) must stay visible to its ledger.
		killProcessTree: (pid) => killProcessTree(pid),
		resolveFd: () => ensureTool("fd"),
	});
	return processMachineOps;
}

/** A ToolMachine over `ops`, or over the process-wide local machine when the caller supplies none. */
export function createToolMachine(options?: { ops?: MachineOps; policy?: ToolPathPolicy }): ToolMachine {
	return bindToolMachine(() => options?.ops ?? defaultLocalMachineOps(), options?.policy);
}

let defaultMachine: ToolMachine | undefined;

/** The ToolMachine a tool factory uses when its options carry none. */
export function defaultToolMachine(): ToolMachine {
	defaultMachine ??= createToolMachine();
	return defaultMachine;
}
