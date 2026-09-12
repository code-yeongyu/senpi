import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";

export type ToolExecutionResult = Omit<AgentToolResult<unknown>, "details"> & {
	readonly details?: unknown;
	readonly isError: boolean;
};

/**
 * What the tool card needs from a tool: how to draw it. It neither executes tools nor reads their
 * parameter schemas, so a full definition and a bare renderer pair (upstream `withBuiltInRenderers`
 * / `createAllToolRenderers`) are equally acceptable; a definition's identity fields are carried
 * along untouched.
 *
 * The renderer parameters are `any` on purpose: a `ToolDefinition` types them from its schema, and
 * narrowing them here would make those definitions unassignable.
 */
export interface ToolRenderers
	extends Partial<Pick<ToolDefinition<any, any, any>, "name" | "label" | "description" | "parameters" | "execute">> {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}

export type ToolExecutionIdentity = {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly cwd: string;
	readonly toolDefinition: ToolRenderers | undefined;
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
