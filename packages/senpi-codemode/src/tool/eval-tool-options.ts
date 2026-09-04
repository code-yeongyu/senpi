import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import type { EvalExecutionTracker } from "../extension/session-manager.ts";
import type { EvalTimeoutFactory } from "./cell-execution.ts";
import type { EvalDetachedCellManager } from "./detached-cell-manager.ts";
import type { EvalExecutionEventPayload } from "./eval-execution-event.ts";
import type { EvalImageResizer } from "./image.ts";
import type {
	EnabledEvalLanguages,
	EvalInputSchema,
	EvalKernelManager,
	EvalRuntimes,
	EvalToolDetails,
	EvalToolInput,
	ExecuteTool,
} from "./types.ts";

export interface CreateEvalToolOptions {
	readonly enabledLanguages: EnabledEvalLanguages;
	readonly kernelManager: EvalKernelManager;
	readonly cellTimeoutSeconds: number;
	/**
	 * Longest an interactive (detach-behavior) call blocks the agent loop before the cell detaches,
	 * capping the `timeout` detach budget. Defaults to {@link DEFAULT_FOREGROUND_WINDOW_SECONDS}.
	 * Does not affect `on_timeout: "error"` calls or the wall-clock hard limit.
	 */
	readonly foregroundWindowSeconds?: number;
	/** Wall-clock kill deadline applied to every cell; only used when this factory creates its own manager. */
	readonly hardLimitSeconds?: number;
	readonly executeTool: ExecuteTool;
	readonly listTools?: () => readonly EvalSchemaToolInfo[];
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly settings?: ResolvedCodemodeSettings;
	readonly artifactsDir?: string;
	readonly imageResizer?: EvalImageResizer;
	readonly executionTracker?: EvalExecutionTracker;
	readonly cellManager?: EvalDetachedCellManager;
	readonly onCellSettled?: (payload: EvalExecutionEventPayload) => void;
	readonly timeoutFactory?: EvalTimeoutFactory;
	readonly proxyExecutor?: (params: EvalToolInput, signal?: AbortSignal) => Promise<AgentToolResult<EvalToolDetails>>;
	readonly renderers?: Pick<ToolDefinition<EvalInputSchema, EvalToolDetails>, "renderCall" | "renderResult">;
	readonly spawns?: boolean;
	/** Whether the session registry exposes the monitor tool through eval. */
	readonly monitor?: boolean;
	readonly spawnDefaultAgent?: string;
	readonly modelId?: string;
	readonly hostLine?: string;
	/** Display identity of each language's runtime, shown in headers and details; `js` also selects the prompt's runtime line. */
	readonly runtimes?: EvalRuntimes;
	/** Absolute path of the active bun-1-4 skill; the prompt names it as MUST READ on a bun kernel. */
	readonly bunSkillPath?: string;
}

export interface EvalCellInvocation {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly ctx: ExtensionContext;
}
