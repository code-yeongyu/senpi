import { JsWorkerRuntime } from "./worker-runtime.js";

export function createWorkerCore(transport, options) {
	let runtime = null;
	const pendingTools = new Map();
	const started = Date.now();

	function emit(message) {
		transport.send(message);
	}

	async function runCell(message) {
		if (!runtime) {
			emit({ type: "result", cellId: message.cellId, ok: false, error: { message: "JS runtime not initialized" }, durationMs: 0 });
			return;
		}
		try {
			const value = await runtime.run(message.code, message.cellId, {
				emit,
				callTool: async (toolName, args) => await callTool(toolName, args),
			});
			emit({ type: "result", cellId: message.cellId, ok: true, valueRepr: valueRepr(value), durationMs: Date.now() - started });
		} catch (error) {
			emit({ type: "result", cellId: message.cellId, ok: false, error: bridgeError(error), durationMs: Date.now() - started });
		}
	}

	async function callTool(toolName, args) {
		const callId = `js-${crypto.randomUUID()}`;
		const promise = new Promise((resolve, reject) => pendingTools.set(callId, { resolve, reject }));
		emit({ type: "tool-call", callId, toolName, args });
		return await promise;
	}

	function onMessage(message) {
		if (message.type === "init") {
			runtime = new JsWorkerRuntime({ cwd: options.cwd, parallelPoolWidth: options.parallelPoolWidth });
			emit({ type: "ready" });
			return;
		}
		if (message.type === "run") {
			void runCell(message);
			return;
		}
		if (message.type === "tool-reply") {
			const pending = pendingTools.get(message.callId);
			if (!pending) return;
			pendingTools.delete(message.callId);
			if (message.ok) pending.resolve(message.value);
			else pending.reject(errorFromBridge(message.error));
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
			globalThis.__senpi_restore_console__?.();
		},
	};
}

function valueRepr(value) {
	if (value === undefined) return undefined;
	return JSON.stringify(value);
}

function bridgeError(error) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack };
	}
	return { message: String(error) };
}

function errorFromBridge(error) {
	const result = new Error(error.message);
	if (error.name) result.name = error.name;
	if (error.stack) result.stack = error.stack;
	return result;
}
