import type { BrowserEngine } from "../../core/browser-engine.ts";
import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import type { RpcSessionState } from "./rpc-types.ts";
import type { RpcSessionLaunchProfile } from "./session-registry.ts";

export const SESSION_WORKER_LIMITS = {
	workers: 20,
	requests: 64,
	controlRequests: 4,
	controlBytes: 1024 * 1024,
	requestBytes: 16 * 1024 * 1024,
	outputBytes: 16 * 1024 * 1024,
	reservations: 64,
	openMs: 30_000,
	controlMs: 5_000,
} as const;

/** Wire values the host writes into a worker's wait signal; `conflict` is the generic denial. */
export const WORKER_CREDIT_CODES = { granted: 1, conflict: 2, limit: 3 } as const;

/** Host decision on a worker's session-write path request. */
export type SessionWriteGrant = keyof typeof WORKER_CREDIT_CODES;

export interface WorkerSnapshot {
	state: RpcSessionState;
	/** Canonicalized by the owning worker, never by the transport thread. */
	sessionPath?: string;
	/** Every canonical path this worker's live session writers still own. */
	liveSessionPaths: readonly string[];
	busy: boolean;
	/** Turn/request activity, excluding durable wake-source holds. */
	handoffBusy?: boolean;
	streaming: boolean;
}

export type HostToSessionWorker =
	| { type: "prepare"; request: number; configuration: CliRuntimeConfiguration; profile: RpcSessionLaunchProfile }
	| { type: "commit"; request: number }
	| { type: "bind"; request: number; sessionId: string; capabilities: readonly string[]; connection?: string }
	| { type: "command"; request: number; command: object; connection?: string }
	| { type: "prompt_surface"; request: number; surface: PromptSurface }
	| { type: "browser_engine"; request: number; engine: BrowserEngine }
	| { type: "permission_preset"; request: number; preset: string }
	| { type: "cancel_ui" }
	| { type: "close" };

export type SessionWorkerToHost =
	| { type: "prepared"; request: number; sessionPath: string }
	| { type: "ready"; request: number; snapshot: WorkerSnapshot }
	| { type: "result"; request: number; error?: string }
	| { type: "reserve"; path: string; signal: SharedArrayBuffer }
	| { type: "snapshot"; snapshot: WorkerSnapshot; signal: SharedArrayBuffer; settled?: boolean }
	| { type: "control_done"; control: "cancel_ui" }
	| {
			type: "output";
			record: object;
			connection?: string;
			signal: SharedArrayBuffer;
			activity: Pick<WorkerSnapshot, "busy" | "handoffBusy" | "streaming">;
			snapshot?: WorkerSnapshot;
	  }
	| { type: "capabilities"; connection?: string; capabilities: readonly string[]; signal: SharedArrayBuffer }
	| { type: "request_close" }
	| { type: "failure"; error: string };
