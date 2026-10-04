import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import type { CodemodeSettings } from "../config/settings.ts";
import type { HandleRegistry } from "../handles/handle-registry.ts";
import type { InterpreterAvailability } from "../interpreters/detect.ts";
import type { SessionEnvironment } from "../kernels/session-env.ts";
import type { EvalKernelManager, ExecuteTool } from "../tool/types.ts";

export interface CodemodeSessionManager extends EvalKernelManager {
	dispose(): Promise<void>;
	complete(request: CompletionRequest, ctx: ExtensionContext): Promise<CompletionResult>;
	setContext?(ctx: ExtensionContext): void;
	bridgeEndpoint?(): BridgeEndpoint;
}

export interface BridgeEndpoint {
	readonly port: number;
	readonly token: string;
}

export interface EvalExecutionTracker {
	assertEvalExecutionAllowed(): void;
	trackEvalExecution<Result>(execution: Promise<Result>, controller: AbortController): Promise<Result>;
}

export interface CreateCodemodeSessionManagerOptions {
	readonly sessionId: string;
	/** The agent session that owns these kernels, as the process kernel registry lists them; defaults to `sessionId`. */
	readonly ownerSessionId?: string;
	readonly cwd: string;
	readonly settings: CodemodeSettings;
	readonly availability: InterpreterAvailability;
	/** Session-scoped roots exposed to kernel helpers such as local://. */
	readonly localRoots?: Readonly<Record<string, string>>;
	/** Session-adjacent directory used for persisted eval artifacts. */
	readonly artifactsDir?: string;
	/** Per-session PI_* values exposed to every kernel and the children it spawns. */
	readonly sessionEnv?: SessionEnvironment;
	readonly executeTool: ExecuteTool;
	readonly listTools?: () => readonly EvalSchemaToolInfo[];
	readonly complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	/** The session generation's handle registry; subprocess kernels reach `wait()`/`handle()` through the bridge. */
	readonly handles?: HandleRegistry;
}
