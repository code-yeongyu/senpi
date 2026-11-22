import { inKernelToolInvoke } from "./kernel-tools-context.js";
import { kernelToolError } from "./kernel-tools-errors.js";

// Only host-tool sugar: no admission, worker, or queue state belongs to the kernel.
export async function createWorkpool(callTool, agent, name, options = {}) {
	if (inKernelToolInvoke()) throw kernelToolError("kernel_tool_recursion", "kernel tools may not invoke workpool()");
	if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "mode" && key !== "tools")) {
		throw new TypeError("workpool() options only accept mode and tools");
	}
	if (options.tools !== undefined && (!Array.isArray(options.tools) || !options.tools.every(name => typeof name === "string"))) {
		throw workpoolError("invalid_tools", `workpool() tools takes an array of tool names; got ${Array.isArray(options.tools) ? "an array with a non-string" : typeof options.tools}`);
	}
	const call = async args => {
		try {
			return await callTool("workpool", args);
		} catch (error) {
			if (error?.code === "unknown_tool" || error?.code === "inactive_tool") {
				throw workpoolError("workpool_unavailable", "No active host workpool tool", error);
			}
			throw error;
		}
	};
	const result = await call({ op: "create", agent, name, ...options });
	if (result.details?.error) throw workpoolError(result.details.error.code, result.details.error.message);
	const pool_id = result.details?.pool_id;
	if (result.hasError || typeof pool_id !== "string" || !/^wp_[0-9a-f]{32}$/.test(pool_id)) {
		throw workpoolError("workpool_unavailable", "Host did not return a workpool identity");
	}
	return Object.freeze({
		pool_id,
		push: items => call({ op: "push", pool_id, items }),
		close: () => call({ op: "close", pool_id }),
		inspect: () => call({ op: "inspect", pool_id }),
		cancel: () => call({ op: "cancel", pool_id }),
	});
}

function workpoolError(code, message, cause) {
	return Object.assign(new Error(message, { cause }), { code });
}
