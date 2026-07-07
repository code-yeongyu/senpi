import type { NativePtyLoadResult } from "./native-loader.ts";
import { normalizeUnknownOperationResult } from "./session-exit.ts";
import type {
	CreateNativeTerminalSession,
	TerminalSessionDataHandler,
	TerminalSessionHandle,
	TerminalSessionNativeOptions,
	TerminalSessionSignal,
} from "./session-types.ts";

type NativeSessionCreator = (options: TerminalSessionNativeOptions, onData: TerminalSessionDataHandler) => unknown;
type NativeSessionConstructor = new (
	options: TerminalSessionNativeOptions,
	onData: TerminalSessionDataHandler,
) => unknown;
type NativeWrite = (data: string | Uint8Array) => unknown;
type NativeResize = (cols: number, rows: number) => unknown;
type NativeKill = (signal?: TerminalSessionSignal) => unknown;
type NativeWait = () => Promise<unknown> | unknown;
type NativeOnData = (handler: TerminalSessionDataHandler) => (() => void) | unknown;

export function getNativeSessionFactory(loadResult: NativePtyLoadResult): CreateNativeTerminalSession | null {
	if (loadResult.native === null) return null;
	const create = loadResult.native.createPtySession ?? loadResult.native.startPtySession;
	if (isNativeSessionCreator(create)) {
		return (options, onData) => normalizeTerminalSessionHandle(create(options, onData));
	}
	const PtySession = loadResult.native.PtySession;
	if (isNativeSessionConstructor(PtySession)) {
		return (options, onData) => normalizeTerminalSessionHandle(new PtySession(options, onData));
	}
	return null;
}

function normalizeTerminalSessionHandle(value: unknown): TerminalSessionHandle {
	if (!isRecord(value)) throw new Error("Native PTY session factory did not return an object");
	const write = value.write;
	const resize = value.resize;
	const kill = value.kill;
	if (!isNativeWrite(write)) throw new Error("Native PTY session handle is missing write()");
	if (!isNativeResize(resize)) throw new Error("Native PTY session handle is missing resize()");
	if (!isNativeKill(kill)) throw new Error("Native PTY session handle is missing kill()");

	const waitExit = value.waitExit;
	const wait = value.wait;
	if (!isNativeWait(waitExit) && !isNativeWait(wait)) {
		throw new Error("Native PTY session handle is missing waitExit() or wait()");
	}

	const requiredHandle = {
		write(data: string | Uint8Array) {
			return normalizeUnknownOperationResult(write.call(value, data));
		},
		resize(cols: number, rows: number) {
			return normalizeUnknownOperationResult(resize.call(value, cols, rows));
		},
		kill(signal?: TerminalSessionSignal) {
			return normalizeUnknownOperationResult(kill.call(value, signal));
		},
	};
	const onData = value.onData;
	if (isNativeWait(waitExit) && isNativeOnData(onData)) {
		return {
			...requiredHandle,
			onData: (handler) => normalizeUnsubscribe(onData.call(value, handler)),
			waitExit: async () => waitExit.call(value),
		};
	}
	if (isNativeWait(waitExit)) return { ...requiredHandle, waitExit: async () => waitExit.call(value) };
	if (isNativeOnData(onData) && isNativeWait(wait)) {
		return {
			...requiredHandle,
			onData: (handler) => normalizeUnsubscribe(onData.call(value, handler)),
			wait: async () => wait.call(value),
		};
	}
	if (isNativeWait(wait)) return { ...requiredHandle, wait: async () => wait.call(value) };
	throw new Error("Native PTY session handle is missing waitExit() or wait()");
}

function normalizeUnsubscribe(value: unknown): () => void {
	return isUnsubscribe(value) ? value : () => {};
}

function isNativeSessionCreator(value: unknown): value is NativeSessionCreator {
	return typeof value === "function";
}

function isNativeSessionConstructor(value: unknown): value is NativeSessionConstructor {
	return typeof value === "function";
}

function isNativeWrite(value: unknown): value is NativeWrite {
	return typeof value === "function";
}

function isNativeResize(value: unknown): value is NativeResize {
	return typeof value === "function";
}

function isNativeKill(value: unknown): value is NativeKill {
	return typeof value === "function";
}

function isNativeWait(value: unknown): value is NativeWait {
	return typeof value === "function";
}

function isNativeOnData(value: unknown): value is NativeOnData {
	return typeof value === "function";
}

function isUnsubscribe(value: unknown): value is () => void {
	return typeof value === "function";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}
