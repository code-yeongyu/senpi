import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDef } from "../../../core/tools/index.ts";

export type ToolExecutionResult = Omit<AgentToolResult<unknown>, "details"> & {
	readonly details?: unknown;
	readonly isError: boolean;
};

export type ToolOutputMode = "collapsed" | "expanded" | "atomic";

export function nextToolOutputMode(mode: ToolOutputMode): ToolOutputMode {
	switch (mode) {
		case "collapsed":
			return "expanded";
		case "expanded":
			return "atomic";
		case "atomic":
			return "collapsed";
	}
}

export type ToolExecutionIdentity = {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly cwd: string;
	readonly toolDefinition: ToolDef | undefined;
	readonly trustedBuiltIn: boolean;
};

export type ToolExecutionRenderState = {
	readonly args: unknown;
	readonly executionStarted: boolean;
	readonly argsComplete: boolean;
	readonly isPartial: boolean;
	readonly expanded: boolean;
	readonly showImages: boolean;
	readonly spinnerFrame: number | undefined;
	readonly result: ToolExecutionResult | undefined;
};
