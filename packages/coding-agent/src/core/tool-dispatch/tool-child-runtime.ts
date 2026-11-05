import { join } from "node:path";
import {
	type ToolRuntimeKind,
	ToolRuntimeUnsupportedHostError,
	toolRuntimeHostRefusal,
} from "../../cli/tool-runtime.ts";
import type { ToolChildCommand } from "../../modes/rpc/tool-child/launch.ts";
import type { ToolChildWake } from "../../modes/rpc/tool-child/client.ts";
import type { HostCallHandler } from "../../modes/rpc/tool-child/host-calls-server.ts";
import { SessionToolChild, type SessionToolChildRecord } from "../../modes/rpc/tool-child/session-child.ts";
import { createSessionHostCallHandler, type SessionHostCallDeps } from "../tool-child-host-calls.ts";
import type { StuckModuleNotice } from "./in-process-module.ts";
import { createToolDispatcher, type ToolDispatcher, type ToolDispatchNotify } from "./tool-dispatcher.ts";

export interface ToolChildRuntimeOptions {
	toolRuntime: ToolRuntimeKind;
	agentDir: string;
	/** Names the tool child's directory (`<agentDir>/tool-children/<scopeId>`); a session passes its session ID. */
	scopeId: string;
	cwd: string;
	/** The directories child `module` jobs may load from, read at every spawn. */
	moduleRoots: () => readonly string[];
	hostCallDeps: SessionHostCallDeps;
	onRecord: (record: SessionToolChildRecord) => void;
	onWake?: (wake: ToolChildWake) => void;
	notify?: ToolDispatchNotify;
	onModuleStuck?: (notice: StuckModuleNotice) => void;
	/** How the tool child is launched; absent means the production launch. */
	command?: ToolChildCommand;
}

export interface ToolChildRuntime {
	dispatcher: ToolDispatcher;
	/** The tool child under `--tool-runtime child`; undefined in-process. */
	toolChild: SessionToolChild | undefined;
	hostCalls: HostCallHandler;
}

/**
 * Build the tool-child runtime: the dispatcher that places tools, the tool child it runs child-placed work on, and the
 * host-call handler both share. `AgentSession` builds its runtime here, and so does a runtime without a session
 * (senpi#5227).
 */
export function createToolChildRuntime(options: ToolChildRuntimeOptions): ToolChildRuntime {
	const hostRefusal = toolRuntimeHostRefusal(options.toolRuntime);
	if (hostRefusal !== undefined) throw new ToolRuntimeUnsupportedHostError(hostRefusal);
	// One host-call handler for both runtimes: the child's reverse bridge and an in-process ctx.offload module.
	const hostCalls = createSessionHostCallHandler(options.hostCallDeps);
	const toolChild =
		options.toolRuntime === "child"
			? new SessionToolChild({
					dir: join(options.agentDir, "tool-children", options.scopeId),
					cwd: options.cwd,
					moduleRoots: options.moduleRoots,
					onRecord: options.onRecord,
					onHostCall: hostCalls,
					...(options.onWake === undefined ? {} : { onWake: options.onWake }),
					...(options.command === undefined ? {} : { command: options.command }),
				})
			: undefined;
	const dispatcher = createToolDispatcher({
		runtime: options.toolRuntime,
		...(options.notify === undefined ? {} : { notify: options.notify }),
		hostCalls,
		...(options.onModuleStuck === undefined ? {} : { onModuleStuck: options.onModuleStuck }),
		...(toolChild === undefined ? {} : { childRunner: toolChild.runner, childKindRunner: toolChild.kindRunner }),
	});
	return { dispatcher, toolChild, hostCalls };
}
