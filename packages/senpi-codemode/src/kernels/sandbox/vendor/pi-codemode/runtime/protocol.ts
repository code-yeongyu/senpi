// Vendored from https://github.com/earendil-works/pi (packages/codemode/src) at v1.0.1, commit a7229ddc21810d6245105978033b7df645ecc2f7.
// MIT license; see LICENSE beside this file. Local changes are listed in VENDORED.md.
import type { CodemodeOutputFrame, CodemodeOutputItem } from "../types.ts";
import type { CodemodeWasmModule } from "../wasm.ts";

/**
 * Messages between the host (main thread) and the worker. Tool arguments,
 * results, and values cross as JSON strings: the worker passes them into and
 * out of the QuickJS VM as strings and never builds structured values itself.
 */

export interface WorkerData {
	code: string;
	/** `jsName` is the identifier the script uses; `description` is listed in `ALL_TOOLS`. */
	tools: { name: string; jsName: string; description: string }[];
	globals: { name: string; spread: boolean }[];
	/** Compiled `quickjs-wasi` module. Structured clone shares the compiled code with the worker. */
	wasm: CodemodeWasmModule;
	memoryLimitBytes: number | undefined;
	/** Snapshot for `load()`: key to JSON text. */
	store: Record<string, string>;
	/**
	 * One Int32 the host sets to non-zero before terminating the worker. The VM's interrupt handler
	 * polls it, because Bun's `worker.terminate()` cannot stop a thread that is spinning in wasm.
	 */
	interrupt: SharedArrayBuffer;
	// senpi-change begin: output streaming and builtin policy
	/** Present in `output: "stream"` mode: one Int32 of free credit bytes the host refills as frames are consumed. */
	stream?: { credits: SharedArrayBuffer; frameBytes: number };
	storePolicy?: "collect" | "reject";
	// senpi-change end
}

/** JSON-encoded `{ name?, message, stack? }` of an error thrown by the script. */
export type ScriptErrorJson = string;

export type WorkerToHostMessage =
	| { type: "call"; id: number; target: "tool" | "global"; name: string; args: string | undefined }
	| { type: "output"; item: CodemodeOutputItem }
	// senpi-change begin: output streaming
	| { type: "output-frame"; frame: CodemodeOutputFrame; bytes: number }
	// senpi-change end
	/** `writes` is a JSON array of `[key, json]` for `store()` and `[key]` for deletions. */
	| { type: "done"; ok: true; value: string | undefined; writes: string }
	| { type: "done"; ok: false; error: ScriptErrorJson }
	/** The VM failed outside the script's control, for example a wasm trap. */
	| { type: "crash"; message: string };

export type HostToWorkerMessage =
	/** `payload` is the JSON result when `ok`, otherwise the error message. */
	{ type: "result"; id: number; ok: boolean; payload: string | undefined };

export function isWorkerToHostMessage(value: unknown): value is WorkerToHostMessage {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return type === "call" || type === "output" || type === "output-frame" || type === "done" || type === "crash";
}

export function isHostToWorkerMessage(value: unknown): value is HostToWorkerMessage {
	return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result";
}
