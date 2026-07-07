import type { PipeFallbackOperationResult, PipeFallbackSessionExit } from "./pipe-fallback.ts";
import type {
	TerminalSessionBackend,
	TerminalSessionExit,
	TerminalSessionExitError,
	TerminalSessionOperationResult,
} from "./session-types.ts";

export function normalizeTerminalExit(
	exit: unknown,
	backend: TerminalSessionBackend,
	killRequested: boolean,
): TerminalSessionExit {
	if (backend === "pipe-fallback" && isPipeFallbackSessionExit(exit)) {
		return normalizePipeFallbackExit(exit, killRequested);
	}
	const record = isRecord(exit) ? exit : {};
	if (record.backend === "pipe-fallback" && isPipeFallbackSessionExit(exit)) {
		return normalizePipeFallbackExit(exit, killRequested);
	}
	const timedOut = readBoolean(record, "timedOut") ?? readBoolean(record, "timed_out") ?? false;
	return {
		backend,
		exitCode: readNullableNumber(record, "exitCode") ?? readNullableNumber(record, "exit_code") ?? null,
		signal: readNullableString(record, "signal"),
		cancelled:
			(readBoolean(record, "cancelled") ?? readBoolean(record, "canceled") ?? false) || killRequested || timedOut,
		timedOut,
		error: readTerminalExitError(record),
	};
}

export function normalizeOperationResult(
	result: TerminalSessionOperationResult | PipeFallbackOperationResult | undefined,
	defaultNote: string,
): TerminalSessionOperationResult {
	if (result === undefined) return { ok: true, note: defaultNote };
	if ("ok" in result) return result;
	return { ok: true, note: defaultNote };
}

export function normalizeUnknownOperationResult(result: unknown): TerminalSessionOperationResult | undefined {
	if (!isRecord(result)) return undefined;
	const ok = result.ok;
	const note = result.note;
	if (typeof ok !== "boolean" || typeof note !== "string") return undefined;
	const code = typeof result.code === "string" ? result.code : undefined;
	const idempotent = typeof result.idempotent === "boolean" ? result.idempotent : undefined;
	return { ok, note, code, idempotent };
}

export function notStartedOperation(operation: string): TerminalSessionOperationResult {
	return {
		ok: false,
		code: "not_started",
		note: `Cannot ${operation} terminal session: session has not started.`,
	};
}

export function exitedOperation(operation: string): TerminalSessionOperationResult {
	return {
		ok: false,
		code: "exited",
		note: `Cannot ${operation} terminal session: session has exited.`,
	};
}

function normalizePipeFallbackExit(exit: PipeFallbackSessionExit, killRequested: boolean): TerminalSessionExit {
	return {
		backend: "pipe-fallback",
		exitCode: exit.exitCode,
		signal: exit.signal,
		cancelled: killRequested || exit.timedOut,
		timedOut: exit.timedOut,
		error: exit.error,
	};
}

function isPipeFallbackSessionExit(value: unknown): value is PipeFallbackSessionExit {
	if (!isRecord(value)) return false;
	const exitCode = value.exitCode;
	const signal = value.signal;
	const timedOut = value.timedOut;
	const error = value.error;
	const exitCodeValid = exitCode === null || (typeof exitCode === "number" && Number.isFinite(exitCode));
	const signalValid = signal === null || typeof signal === "string";
	const errorValid = error === undefined || isTerminalExitError(error);
	return exitCodeValid && signalValid && typeof timedOut === "boolean" && errorValid;
}

function isTerminalExitError(value: unknown): value is TerminalSessionExitError {
	if (!isRecord(value)) return false;
	return typeof value.code === "string" && typeof value.message === "string";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function readNullableNumber(record: Readonly<Record<string, unknown>>, key: string): number | null | undefined {
	const value = record[key];
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNullableString(record: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = record[key];
	if (value === null) return null;
	return typeof value === "string" ? value : null;
}

function readBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function readTerminalExitError(record: Readonly<Record<string, unknown>>): TerminalSessionExitError | undefined {
	const error = record.error;
	if (!isTerminalExitError(error)) return undefined;
	return error;
}
