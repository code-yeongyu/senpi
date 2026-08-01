import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@code-yeongyu/senpi";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import type { EvalExecutionTracker } from "../extension/session-manager.ts";
import type { EvalTimeoutFactory } from "./cell-execution.ts";
import type { EvalDetachedCellManager } from "./detached-cell-manager.ts";
import type { EvalImageResizer } from "./image.ts";
import type {
	EnabledEvalLanguages,
	EvalInputSchema,
	EvalKernelManager,
	EvalToolDetails,
	EvalToolInput,
	ExecuteTool,
} from "./types.ts";

export interface CreateEvalToolOptions {
	readonly enabledLanguages: EnabledEvalLanguages;
	readonly kernelManager: EvalKernelManager;
	readonly cellTimeoutSeconds: number;
	readonly executeTool: ExecuteTool;
	readonly listTools?: () => readonly EvalSchemaToolInfo[];
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly settings?: ResolvedCodemodeSettings;
	readonly artifactsDir?: string;
	readonly imageResizer?: EvalImageResizer;
	readonly executionTracker?: EvalExecutionTracker;
	readonly cellManager?: EvalDetachedCellManager;
	readonly timeoutFactory?: EvalTimeoutFactory;
	readonly proxyExecutor?: (params: EvalToolInput, signal?: AbortSignal) => Promise<AgentToolResult<EvalToolDetails>>;
	readonly renderers?: Pick<ToolDefinition<EvalInputSchema, EvalToolDetails>, "renderCall" | "renderResult">;
	readonly spawns?: boolean;
	readonly spawnDefaultAgent?: string;
	readonly modelId?: string;
	readonly hostLine?: string;
}

export interface EvalCellInvocation {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly ctx: ExtensionContext;
}
