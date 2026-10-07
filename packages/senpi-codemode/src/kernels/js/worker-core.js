import { installCellOwnership } from "./cell-ownership.js";
import { releaseCell, releasedCellError, runInCell } from "./cell-run-context.js";
import { kernelToolCallContext } from "./kernel-tools-context.js";
import { kernelToolError } from "./kernel-tools-errors.js";
import { createKernelToolPump } from "./kernel-tools-pump.js";
import { hostDeniedError, hostToolRefusal } from "./kernel-tools-scope.js";
import { installSessionCwd } from "./worker-cwd.js";
import { installPackageResolver } from "./worker-package-resolve.js";
import { createHeapProbe } from "./worker-heap.js";
import { createRejectionReports } from "./rejection-reports.js";
import { createWorkerMemory } from "./worker-memory.js";
import { JsWorkerRuntime } from "./worker-runtime.js";
import { installKernelWebView } from "./worker-webview.js";

// Mirrors INTERRUPT_ACK_OP, CHILD_LIFECYCLE_OP, and MEMORY_COLLECTED_OP in src/bridge/reserved.ts (this worker file cannot import TypeScript).
const INTERRUPT_ACK_OP = "interrupt-ack";
const CHILD_LIFECYCLE_OP = "child";
const MEMORY_COLLECTED_OP = "memory-collected";

// Mirrors SESSION_ENVIRONMENT_KEYS in src/kernels/session-env.ts (this worker file
// cannot import TypeScript). Keys the active session does not set must be dropped so a
// value inherited from the host environment never leaks into a cell or its children.
const SESSION_ENVIRONMENT_KEYS = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_SESSION_CWD",
	"PI_GOAL_STORE_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
	"OMO_BROWSER_ENGINE",
];

export function createWorkerCore(transport, options) {
	const restoreOwnership = installCellOwnership();
	let runtime = null;
	let memory = null;
	let heapProbe = null;
	let activeCell = null;
	const rejections = createRejectionReports({
		activeCell: () => activeCell,
		emitText: (data) => emit({ type: "text", stream: "stderr", data }),
	});
	const reportRejection = (reason) => rejections.report(reason);
	process.on("unhandledRejection", reportRejection);
	const pendingTools = new Map();
	const pendingWebViewPorts = new Map();
	const nestedInvokes = new Map();
	const kernelTools = createKernelToolPump({
		getRuntime: () => runtime,
		emit: (message) => transport.send(message),
		nestedInvokes,
	});

	function emit(message) {
		transport.send(message);
	}

	function stopProblem(cell, what, error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		emit({ type: "text", stream: "stderr", data: `Stopping cell ${cell.cellId}: ${what}: ${detail}\n` });
	}

	async function runCell(message) {
		if (!runtime) {
			emit({ type: "result", cellId: message.cellId, ok: false, error: { message: "JS runtime not initialized" }, durationMs: 0 });
			return;
		}
		const startedAtMs = performance.now();
		const release = Promise.withResolvers();
		const cell = { cellId: message.cellId, interruption: null, released: false, release: release.reject };
		activeCell = cell;
		rejections.startCell(cell);
		try {
			const run = runInCell(cell, () =>
				runtime.run(message.code, message.cellId, {
					emit: (event) => {
						if (releasedCellError() === undefined) emit(event);
					},
					callTool: async (toolName, args) => await callTool(toolName, args),
				}),
			);
			const value = await Promise.race([run, release.promise]);
			rejections.finishCell(cell);
			emit({ type: "result", cellId: message.cellId, ok: true, valueRepr: valueRepr(value), durationMs: durationMs(startedAtMs), ...memoryReport() });
		} catch (error) {
			rejections.finishCell(cell);
			emit({ type: "result", cellId: message.cellId, ok: false, error: bridgeError(error), durationMs: durationMs(startedAtMs), ...memoryReport() });
		} finally {
			if (activeCell === cell) activeCell = null;
		}
	}

	function memoryReport() {
		return memory === null ? {} : { memory: memory.afterCell() };
	}

	async function callTool(toolName, args) {
		const released = releasedCellError();
		if (released !== undefined) throw released;
		const nested = kernelToolCallContext.getStore();
		if (!nested && activeCell?.interruption) throw activeCell.interruption;
		if (nested?.signal.aborted) throw nested.signal.reason;
		// A scoped kernel-tool call is refused here, before anything reaches the host bridge, so the
		// closure sees a rejected promise and the parent's own cells keep their full tool surface (#1731).
		if (nested) {
			const refusal = hostToolRefusal(nested.scope, toolName);
			if (refusal) throw hostDeniedError(toolName, nested.callId, refusal);
		}
		const bag = nested?.pendingTools ?? pendingTools;
		const callId = `js-${crypto.randomUUID()}`;
		const promise = new Promise((resolve, reject) => bag.set(callId, { resolve, reject }));
		emit({ type: "tool-call", callId, toolName, args });
		return await promise;
	}

	function requestWebViewPort() {
		const requestId = crypto.randomUUID();
		const promise = new Promise((resolve, reject) => pendingWebViewPorts.set(requestId, { resolve, reject }));
		emit({ type: "webview-connect", requestId });
		return promise;
	}

	function interruptCell(reason) {
		if (!activeCell || !runtime) return;
		acknowledgeInterrupt();
		const interruption = cellInterruptedError(reason);
		activeCell.interruption = interruption;
		for (const [callId, pending] of pendingTools) {
			pendingTools.delete(callId);
			pending.reject(interruption);
		}
		kernelTools.abortAll(kernelToolError("kernel_tool_stale", interruption.message));
		runtime.interrupt();
		// A free event loop with no Bun.$ wait can let the cell go and keep the VM. A Bun.$ wait keeps the
		// restart (#2453): the shell cannot be cancelled, so only retiring the worker ends it.
		if (runtime.shellWaitActive) return;
		const cell = activeCell;
		for (const error of releaseCell(cell)) stopProblem(cell, "a resource it opened would not close", error);
		// The result settles after the cell's children are gone, so the next cell never overlaps them. A failed release
		// is reported as such, never left to surface as an unhandled rejection blamed on the stopped cell.
		void runtime
			.release()
			.catch((error) => stopProblem(cell, "releasing its work failed", error))
			.finally(() => cell.release(interruption));
	}

	function acknowledgeInterrupt() {
		if (!activeCell || !runtime) return;
		emit({ type: "status", event: { op: INTERRUPT_ACK_OP, cellId: activeCell.cellId, shellWaitActive: runtime.shellWaitActive } });
	}

	function onMessage(message) {
		if (message.type === "run" || message.type === "interrupt" || message.type === "close") memory?.cancelIdle();
		if (kernelTools.handle(message)) return;
		if (message.type === "kernel-tools-names") {
			runtime?.kernelTools.setCollisionNames(message.hostToolNames ?? [], message.foreignLanguageNames ?? []);
			return;
		}
		if (message.type === "webview-port") {
			const pending = pendingWebViewPorts.get(message.requestId);
			pendingWebViewPorts.delete(message.requestId);
			if (message.ok) pending?.resolve(message.port);
			else pending?.reject(errorFromBridge(message.error));
			return;
		}
		if (message.type === "init") {
			applySessionEnvironment(message.sessionEnv);
			installSessionCwd(options.cwd, options.cwdInstallOptions);
			installKernelWebView(requestWebViewPort);
			installPackageResolver();
			runtime = new JsWorkerRuntime({
				cwd: options.cwd,
				parallelPoolWidth: options.parallelPoolWidth,
				localRoots: message.connection.localRoots,
				artifactsDir: message.connection.artifactsDir,
				kernelGeneration: message.kernelGeneration ?? 1,
				hostToolNames: message.hostToolNames ?? [],
				foreignLanguageNames: message.foreignLanguageNames ?? [],
				kernelToolsDisabled: message.kernelToolsDisabled === true,
				onChildEvent: (event) => emit({ type: "status", event: { op: CHILD_LIFECYCLE_OP, ...event } }),
				onShellWaitChange: () => {
					if (activeCell?.interruption) acknowledgeInterrupt();
				},
			});
			// A process-mode kernel measures its memory host-side as a footprint; the in-heap
			// worker reading would contradict it, so the child keeps memory collection off.
			if (message.memory && !options.processModeMemory) {
				memory = createWorkerMemory(message.memory, (report) => emit({ type: "status", event: { op: MEMORY_COLLECTED_OP, ...report } }));
				memory.captureBaseline();
			}
			emit({ type: "ready" });
			return;
		}
		if (message.type === "memory-query") {
			heapProbe ??= createHeapProbe();
			emit({ type: "memory-query-result", requestId: message.requestId, liveBytes: Math.round(heapProbe.estimate()), measure: "heap" });
			return;
		}
		if (message.type === "run") {
			void runCell(message);
			return;
		}
		if (message.type === "tool-reply") {
			if (kernelTools.settleToolReply(message)) return;
			const pending = pendingTools.get(message.callId);
			if (!pending) return;
			pendingTools.delete(message.callId);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(errorFromBridge(message.error));
			return;
		}
		if (message.type === "interrupt") {
			interruptCell(message.reason ?? "interrupted");
			return;
		}
		if (message.type === "close") {
			emit({ type: "closed" });
			transport.close();
		}
	}

	const unsubscribe = transport.onMessage(onMessage);
	return {
		dispose() {
			unsubscribe();
			restoreOwnership();
			process.off("unhandledRejection", reportRejection);
			globalThis.__senpi_restore_console__?.();
		},
	};
}

function durationMs(startedAtMs) {
	return Math.max(0, Math.round(performance.now() - startedAtMs));
}

function applySessionEnvironment(sessionEnv) {
	const provided = new Set(Object.keys(sessionEnv ?? {}));
	const deleted = [];
	for (const key of SESSION_ENVIRONMENT_KEYS) {
		if (key in process.env && !provided.has(key)) deleted.push(key);
		delete process.env[key];
	}
	const applied = Object.entries(sessionEnv ?? {});
	for (const [key, value] of applied) process.env[key] = value;
	// A worker's process.env is its own view: Bun.$ and node:child_process read it, but Bun.spawn
	// without an explicit env inherits the OS environ, which also still holds deleted keys because
	// `delete process.env.X` does not unsetenv under Bun. installShellCapture reads these flags and
	// pins the worker's environment view for such children (see worker-shell-capture.js).
	globalThis.__senpi_session_env_deletions__ = deleted;
	globalThis.__senpi_session_env_applied__ = applied.length > 0 || deleted.length > 0;
}

function valueRepr(value) {
	if (value === undefined) return undefined;
	return JSON.stringify(value);
}

function cellInterruptedError(reason) {
	const error = new Error(`JS cell interrupted: ${reason}`);
	error.name = "CellInterruptedError";
	return error;
}

function bridgeError(error) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, ...(typeof error.code === "string" ? { code: error.code } : {}) };
	}
	return { message: String(error) };
}

function errorFromBridge(error) {
	const result = new Error(error.message);
	if (error.name) result.name = error.name;
	if (error.stack) result.stack = error.stack;
	if (typeof error.code === "string") result.code = error.code;
	return result;
}
