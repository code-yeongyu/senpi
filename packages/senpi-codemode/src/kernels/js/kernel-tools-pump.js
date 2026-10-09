import { kernelToolCallContext } from "./kernel-tools-context.js";
import { kernelToolError } from "./kernel-tools-errors.js";

export function createKernelToolPump({ getRuntime, emit, nestedInvokes }) {
	async function describe(message) {
		try {
			const runtime = getRuntime();
			if (!runtime?.kernelTools) throw kernelToolError("tools_unavailable", "JS runtime not initialized");
			const results = runtime.kernelTools.describe(message.names).results;
			emit({ type: "kernel-tool-describe-reply", requestId: message.requestId, ok: true, results });
		} catch (error) {
			emit({ type: "kernel-tool-describe-reply", requestId: message.requestId, ok: false, error: pumpError(error) });
		}
	}

	async function invoke(message) {
		const pendingTools = new Map();
		const controller = new AbortController();
		nestedInvokes.set(message.requestId, { pendingTools, controller });
		try {
			const runtime = getRuntime();
			if (!runtime?.kernelTools) throw kernelToolError("tools_unavailable", "JS runtime not initialized");
			const value = await kernelToolCallContext.run(
				// The scope lives only in this store: it is gone once the call settles, and it never
				// reaches the top-level cell context or the next invocation (#1731).
				{
					pendingTools,
					callId: message.call_id,
					generation: message.kernel_generation,
					signal: controller.signal,
					scope: message.scope,
				},
				() =>
					runtime.kernelTools.invoke(
						{
							name: message.name,
							kernel_generation: message.kernel_generation,
							definition_revision: message.definition_revision,
							args: message.args,
							call_id: message.call_id,
						},
						controller.signal,
					),
			);
			emit({ type: "kernel-tool-invoke-reply", requestId: message.requestId, ok: true, value });
		} catch (error) {
			emit({ type: "kernel-tool-invoke-reply", requestId: message.requestId, ok: false, error: pumpError(error) });
		} finally {
			nestedInvokes.delete(message.requestId);
		}
	}

	return {
		handle(message) {
			if (message.type === "kernel-tool-describe") {
				void describe(message);
				return true;
			}
			if (message.type === "kernel-tool-invoke") {
				void invoke(message);
				return true;
			}
			if (message.type === "kernel-tool-cancel") {
				const nested = nestedInvokes.get(message.requestId);
				if (nested) abortNested(nested, kernelToolError("kernel_tool_stale", "Kernel tool call cancelled"));
				return true;
			}
			return false;
		},
		abortAll(error) {
			for (const nested of nestedInvokes.values()) abortNested(nested, error);
		},
		settleToolReply(message) {
			for (const nested of nestedInvokes.values()) {
				const pending = nested.pendingTools.get(message.callId);
				if (!pending) continue;
				nested.pendingTools.delete(message.callId);
				if (message.ok) pending.resolve(message.value);
				else pending.reject(errorFrom(message.error));
				return true;
			}
			return false;
		},
	};
}

function abortNested(nested, error) {
	nested.controller.abort(error);
	for (const [callId, pending] of nested.pendingTools) {
		nested.pendingTools.delete(callId);
		pending.reject(error);
	}
}

function pumpError(error) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			...(typeof error.code === "string" ? { code: error.code } : {}),
			...(isPlainRecord(error.details) ? { details: error.details } : {}),
		};
	}
	return { message: String(error) };
}

function isPlainRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorFrom(error) {
	const result = new Error(error.message);
	if (error.name) result.name = error.name;
	if (error.stack) result.stack = error.stack;
	if (typeof error.code === "string") result.code = error.code;
	if (isPlainRecord(error.details)) result.details = error.details;
	return result;
}
