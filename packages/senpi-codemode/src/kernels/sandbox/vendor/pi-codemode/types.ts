// Vendored from https://github.com/earendil-works/pi (packages/codemode/src) at v1.0.1, commit a7229ddc21810d6245105978033b7df645ecc2f7.
// MIT license; see LICENSE beside this file. Local changes are listed in VENDORED.md.
import type { CodemodeWasmModule } from "./wasm.ts";

export interface CodemodeToolContext {
	/**
	 * Aborted when the script finishes (including unawaited calls), the
	 * execution times out, the caller aborts, or the sandbox is closed.
	 */
	signal: AbortSignal;
}

/** A JSON Schema document. Only used to render declarations; values are not validated against it. */
export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

export interface CodemodeTool {
	/**
	 * The script calls tools as `tools.<id>(args)`, where `<id>` is the name with characters that
	 * are not valid in identifiers replaced by `_` (see `toCodemodeIdentifier`), and also as
	 * `tools["<name>"](args)`. Globals are called as `<name>(args)` and must be identifiers, or
	 * `<namespace>.<member>`, which groups them into a frozen namespace object.
	 */
	name: string;
	/** Shown as a doc comment in {@link renderDeclarations}, and listed in `ALL_TOOLS` for tools. */
	description?: string;
	/** Schema of the single argument. Rendered as the parameter type; `unknown` when omitted. */
	inputSchema?: CodemodeJsonSchema;
	/** Schema of the resolved value. Rendered as the promise type; `unknown` when omitted. */
	outputSchema?: CodemodeJsonSchema;
	/** Globals only: `execute` receives all call arguments as an array instead of the first one. */
	spread?: boolean;
	/**
	 * Globals only: TypeScript parameter list and return type for {@link renderDeclarations}, for
	 * example `(type: string, id?: string): Promise<Model[]>`. Replaces the rendering from the schemas.
	 */
	signature?: string;
	/**
	 * `args` is whatever the script passed, after a JSON round trip. The return
	 * value must be JSON-serializable; a thrown error surfaces in the script as
	 * an `Error` with the same message.
	 */
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

/**
 * One item of the script's output, in the order the script produced it: `text()` and `console.*`
 * produce text items, `image()` image items. `data` is base64.
 */
export type CodemodeOutputItem = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}

export type CodemodeErrorKind =
	/** The script threw or failed to parse. `name` and `stack` come from the script's error. */
	| "script"
	/** The overall deadline expired. The worker was terminated. */
	| "timeout"
	/** The caller's signal fired or the sandbox was closed. The worker was terminated. */
	| "aborted"
	/** The worker or VM failed outside the script's control (for example a wasm trap or a missing worker file). */
	| "sandbox";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
	/** senpi-change: set by the runtime itself (never from script text) for its own memory-limit and stalled failures. */
	reason?: "memory" | "unresolved";
}

/** Keys the script changed with `store()`. Only successful executions report writes. */
export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	/** Keys stored as `undefined`. */
	delete: string[];
}
// senpi-change begin: output streaming
/**
 * One transport frame of an output item in `output: "stream"` mode. An item is split into frames of at most
 * `frameBytes` (UTF-16 bytes of `chunk`); frames of one item share `itemId`, arrive in `seq` order, and the
 * last one has `final: true`. Image frames carry base64 text and repeat the item's `mimeType`.
 */
export interface CodemodeOutputFrame {
	itemId: number;
	seq: number;
	final: boolean;
	type: "text" | "image";
	chunk: string;
	mimeType?: string;
}

/** Bounds observed in `output: "stream"` mode: frames delivered and the most bytes ever in flight. */
export interface CodemodeStreamStats {
	frames: number;
	maxInFlightBytes: number;
	windowBytes: number;
}
// senpi-change end

// senpi-change begin: output streaming (replaces upstream's CodemodeResult union to add `streamed`)
/** `output` is kept for failed executions too, up to the failure. `exit()` completes with `value: undefined`. */
export type CodemodeResult = (
	| {
			ok: true;
			value: unknown;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			storeWrites: CodemodeStoreWrites;
	  }
	| { ok: false; error: CodemodeError; output: CodemodeOutputItem[]; calls: CodemodeCall[] }
) & {
	/** Set in `output: "stream"` mode, where `output` stays empty because every item went to `onOutputFrame`. */
	streamed?: CodemodeStreamStats;
};
// senpi-change end

export interface CodemodeSandboxOptions {
	tools?: CodemodeTool[];
	/**
	 * Functions exposed as top-level identifiers instead of on `tools`, for host helpers such as
	 * attaching an image to the result. They behave like tools (JSON round trip, promise result)
	 * but are not recorded in `result.calls`. Names must be identifiers and may not shadow the
	 * built-in globals (`tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `store`, `load`).
	 */
	globals?: CodemodeTool[];
	/**
	 * Overall deadline per execution, including time spent in tools. `Infinity` disables the
	 * deadline; the execution then only ends when the script settles or is aborted.
	 * Default: 300000.
	 */
	timeoutMs?: number;
	/**
	 * Maximum memory the QuickJS VM may allocate. Allocations beyond it fail inside the script as
	 * `InternalError: out of memory`. Default: no limit beyond wasm32's 4 GiB address space.
	 */
	memoryLimitBytes?: number;
	/**
	 * Compiled `quickjs-wasi/quickjs.wasm`, usually from {@link loadQuickJSWasm}. Default:
	 * `loadQuickJSWasm()`, the file in the installed `quickjs-wasi` package. Pass it when that file
	 * is not on disk, for example in a Bun compiled executable.
	 */
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Worker entry that imports `@earendil-works/pi-codemode/worker`. Default: this package's own
	 * worker file. Pass it when this package is bundled, since the default is resolved relative to
	 * the module that creates the sandbox. Bun compiled executables require the relative string
	 * specifier of an embedded build entrypoint; other hosts usually use a URL.
	 */
	workerUrl?: string | URL;
	// senpi-change begin: output streaming and builtin policy
	/**
	 * `"collect"` (default) keeps output items until the script settles and returns them in `result.output`.
	 * `"stream"` keeps nothing: each item is split into frames handed to `onOutputFrame` as they arrive, the
	 * worker blocks once `windowBytes` of frames are unconsumed, and the per-script output limits do not apply.
	 */
	output?: "collect" | "stream";
	/** Receives frames in order in `"stream"` mode; the next frame is handed over only after this settles. */
	onOutputFrame?: (frame: CodemodeOutputFrame) => void | Promise<void>;
	/** Bytes of frames that may be unconsumed at once in `"stream"` mode. Default: 262144. */
	windowBytes?: number;
	/** Largest frame in `"stream"` mode, at most `windowBytes`. Default: 65536. */
	frameBytes?: number;
	/**
	 * `store: "collect"` (default) is upstream's `store()`/`load()`. `"reject"` keeps the names but holds no state:
	 * `load()` returns `undefined` and `store()` throws an error named `CodemodeStoreDisabledError`.
	 */
	builtins?: { store?: "collect" | "reject" };
	// senpi-change end
}

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** Overrides the sandbox default for this execution. */
	timeoutMs?: number;
	/**
	 * Values the script reads with `load(key)`. Must be JSON-serializable. The script's own
	 * `store()` calls come back as `result.storeWrites`; persisting them is up to the caller.
	 */
	store?: Readonly<Record<string, unknown>>;
}
