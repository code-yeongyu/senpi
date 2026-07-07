import type { Buffer } from "node:buffer";
import type { NativePtyLoadResult } from "./native-loader.ts";

export type TerminalSessionBackend = "native" | "pipe-fallback";
export type TerminalSessionDataHandler = (chunk: Buffer) => void;
export type TerminalSessionSignal = NodeJS.Signals;

export interface TerminalSessionOptions {
	readonly command?: string;
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cols?: number;
	readonly rows?: number;
	readonly timeoutMs?: number;
	readonly rawTailBytes?: number;
}

export interface TerminalSessionNativeOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly cols: number;
	readonly rows: number;
	readonly timeoutMs?: number;
}

export interface TerminalSessionOperationResult {
	readonly ok: boolean;
	readonly note: string;
	readonly code?: string;
	readonly idempotent?: boolean;
}

export interface TerminalSessionExitError {
	readonly code: string;
	readonly message: string;
}

export interface TerminalSessionExit {
	readonly backend: TerminalSessionBackend;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly cancelled: boolean;
	readonly timedOut: boolean;
	readonly error?: TerminalSessionExitError;
}

export type TerminalSessionExitState =
	| {
			readonly status: "not_started" | "running";
			readonly exit: null;
	  }
	| {
			readonly status: "exited";
			readonly exit: TerminalSessionExit;
	  };

export interface TerminalSessionHandle {
	readonly onData?: (handler: TerminalSessionDataHandler) => () => void;
	readonly write: (data: string | Uint8Array) => TerminalSessionOperationResult | undefined;
	readonly resize: (cols: number, rows: number) => TerminalSessionOperationResult | undefined;
	readonly kill: (signal?: TerminalSessionSignal) => TerminalSessionOperationResult | undefined;
	readonly waitExit?: () => Promise<unknown>;
	readonly wait?: () => Promise<unknown>;
}

export type CreateNativeTerminalSession = (
	options: TerminalSessionNativeOptions,
	onData: TerminalSessionDataHandler,
) => TerminalSessionHandle;

export interface TerminalSessionDependencies {
	readonly nativeLoadResult?: NativePtyLoadResult;
	readonly createNativeSession?: CreateNativeTerminalSession;
	readonly env?: Readonly<Record<string, string | undefined>>;
}
