import { accessSync, constants } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type {
	RegisterSecureFileMonitorOptions,
	SecureFileMonitorWorkerEvent,
	SecureWorkerResponse,
} from "./secure-file-monitor-worker-protocol.ts";

export function resolveSecureWorkerExecutable(
	executable: string,
	environment: Readonly<NodeJS.ProcessEnv> = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (isAbsolute(executable)) return executable;
	if (executable.includes("/") || executable.includes("\\")) {
		throw new Error("Secure file monitor worker executable must be absolute.");
	}
	const searchPath = Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1];
	const extensions =
		platform === "win32" && extname(executable).length === 0
			? (Object.entries(environment).find(([key]) => key.toUpperCase() === "PATHEXT")?.[1] ?? ".COM;.EXE;.BAT;.CMD")
					.split(";")
					.filter((extension) => extension.length > 0)
			: [""];
	for (const directory of searchPath?.split(delimiter) ?? []) {
		if (!isAbsolute(directory)) continue;
		for (const extension of extensions) {
			const candidate = join(directory, `${executable}${extension}`);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Keep searching trusted absolute PATH entries.
			}
		}
	}
	throw new Error(`Secure file monitor worker executable not found: ${executable}`);
}

export function deliverSecureWorkerEvent(
	onEvent: RegisterSecureFileMonitorOptions["onEvent"],
	event: SecureFileMonitorWorkerEvent,
	onError?: (error: Error) => void,
): void {
	try {
		onEvent(event);
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		try {
			if (onError) onError(failure);
			else process.emitWarning(failure);
		} catch (reportError) {
			process.emitWarning(
				new AggregateError(
					[failure, reportError instanceof Error ? reportError : new Error(String(reportError))],
					"Secure file monitor error reporting failed.",
				),
			);
		}
	}
}

export function sanitizeSecureWorkerEnvironment(
	environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(environment)) {
		const normalizedKey = key.toUpperCase();
		if ((normalizedKey === "SYSTEMROOT" || normalizedKey === "WINDIR") && value !== undefined) {
			sanitized[normalizedKey] = value;
		}
	}
	return sanitized;
}

export function parseSecureWorkerResponse(line: string): SecureWorkerResponse {
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid secure worker response.");
	switch (value.type) {
		case "ready":
			if (typeof value.device !== "string" || typeof value.inode !== "string") {
				throw new Error("Invalid secure worker ready response.");
			}
			return { type: "ready", device: value.device, inode: value.inode };
		case "registered":
		case "reconciled":
		case "cancelled":
			return { type: value.type, requestId: parseRequestId(value.requestId) };
		case "request_error":
			if (typeof value.message !== "string") throw new Error("Invalid secure worker error response.");
			return { type: "request_error", requestId: parseRequestId(value.requestId), message: value.message };
		case "event":
			if (typeof value.id !== "string" || !isSecureWorkerEvent(value.event)) {
				throw new Error("Invalid secure worker event response.");
			}
			return { type: "event", id: value.id, event: value.event };
		default:
			throw new Error(`Unknown secure worker response type: ${value.type}`);
	}
}

function parseRequestId(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid secure worker request id.");
	return value as number;
}

function isSecureWorkerEvent(value: unknown): value is SecureFileMonitorWorkerEvent {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type === "created" || value.type === "modified" || value.type === "timed_out") return true;
	return value.type === "error" && typeof value.message === "string";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
