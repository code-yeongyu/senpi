import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { generateCorrelationId } from "../../bridge/protocol.ts";
import { RESERVED_AGENT_TOOL } from "../../bridge/reserved.ts";
import { kernelToolError } from "../js/kernel-tools-errors.ts";
import type {
	KernelToolsDescribeResult,
	KernelToolsInvokeOptions,
	KernelToolsInvokeRequest,
	KernelToolsInvokeScope,
} from "../js/kernel-tools-types.ts";

type KernelToolReply = Extract<
	KernelToHostMessage,
	{ type: "kernel-tool-describe-reply" } | { type: "kernel-tool-invoke-reply" }
>;

type Waiter = {
	readonly resolve: (message: KernelToolReply) => void;
	readonly reject: (error: Error) => void;
};

export class KernelToolHostPump {
	readonly events = new EventTarget();
	readonly #waiters = new Map<string, Waiter>();
	readonly #post: (message: HostToKernelMessage) => void;
	readonly #isOpen: () => boolean;

	constructor(post: (message: HostToKernelMessage) => void, isOpen: () => boolean) {
		this.#post = post;
		this.#isOpen = isOpen;
	}

	consume(message: KernelToHostMessage): boolean {
		if (message.type === "tool-call" && message.toolName === RESERVED_AGENT_TOOL) {
			this.events.dispatchEvent(new Event("outerAwaitingAgent"));
		}
		if (message.type !== "kernel-tool-describe-reply" && message.type !== "kernel-tool-invoke-reply") return false;
		const waiter = this.#waiters.get(message.requestId);
		if (!waiter) return true;
		this.#waiters.delete(message.requestId);
		waiter.resolve(message);
		return true;
	}

	rejectAll(error: Error): void {
		for (const [requestId, waiter] of this.#waiters) {
			this.#waiters.delete(requestId);
			waiter.reject(error);
		}
	}

	async describe(names: readonly string[]): Promise<KernelToolsDescribeResult> {
		const reply = await this.#request({
			type: "kernel-tool-describe",
			requestId: generateCorrelationId(),
			names: [...names],
		});
		if (reply.type !== "kernel-tool-describe-reply") {
			throw kernelToolError("kernel_tool_failed", "unexpected kernel-tool describe reply");
		}
		if (!reply.ok) {
			throw kernelToolError(codeOf(reply.error.code), reply.error.message);
		}
		return { results: reply.results as KernelToolsDescribeResult["results"] };
	}

	/**
	 * `options` is the caller's abort signal, or `{ signal?, scope? }` where `scope` bounds the host
	 * tools the invoked closure may reach during this call only. A call without a scope posts exactly
	 * the message it always did (#1731).
	 */
	async invoke(request: KernelToolsInvokeRequest, options?: AbortSignal | KernelToolsInvokeOptions): Promise<unknown> {
		const { signal, scope } = normalizeInvokeOptions(options);
		this.events.dispatchEvent(new Event("nestedInvoke"));
		const reply = await this.#request(
			{
				type: "kernel-tool-invoke",
				requestId: generateCorrelationId(),
				name: request.name,
				kernel_generation: request.kernel_generation,
				definition_revision: request.definition_revision,
				args: request.args,
				call_id: request.call_id,
				...wireScope(scope),
			},
			signal,
		);
		if (reply.type !== "kernel-tool-invoke-reply") {
			throw kernelToolError("kernel_tool_failed", "unexpected kernel-tool invoke reply");
		}
		if (!reply.ok) throw kernelToolError(codeOf(reply.error.code), reply.error.message, reply.error.details);
		return reply.value;
	}

	#request(
		message: Extract<HostToKernelMessage, { requestId: string }>,
		signal?: AbortSignal,
	): Promise<KernelToolReply> {
		if (!this.#isOpen()) throw kernelToolError("tools_unavailable", "JavaScript worker is not available");
		return new Promise((resolve, reject) => {
			const onAbort = (): void => {
				if (!this.#waiters.delete(message.requestId)) return;
				this.#post({ type: "kernel-tool-cancel", requestId: message.requestId });
				reject(kernelToolError("kernel_tool_stale", "Kernel tool call cancelled"));
			};
			const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
			this.#waiters.set(message.requestId, {
				resolve: (reply) => {
					cleanup();
					resolve(reply);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#post(message);
		});
	}
}

/**
 * The scope as the protocol carries it: own copies of the caller's lists, and nothing at all when the
 * caller named no host tools, so an unscoped call posts exactly the message it always did.
 */
function wireScope(scope?: KernelToolsInvokeScope): { scope?: { tools: { allow?: string[]; deny?: string[] } } } {
	const tools = scope?.tools;
	if (tools === undefined) return {};
	if (tools.allow === undefined && tools.deny === undefined) return {};
	return {
		scope: {
			tools: {
				...(tools.allow === undefined ? {} : { allow: [...tools.allow] }),
				...(tools.deny === undefined ? {} : { deny: [...tools.deny] }),
			},
		},
	};
}

function normalizeInvokeOptions(options?: AbortSignal | KernelToolsInvokeOptions): KernelToolsInvokeOptions {
	if (options === undefined) return {};
	return isAbortSignal(options) ? { signal: options } : options;
}

function isAbortSignal(options: AbortSignal | KernelToolsInvokeOptions): options is AbortSignal {
	return options instanceof AbortSignal || "aborted" in options;
}

function codeOf(
	code: string | undefined,
):
	| "kernel_tool_failed"
	| "kernel_tool_stale"
	| "kernel_tool_missing"
	| "kernel_tool_recursion"
	| "kernel_tool_host_denied"
	| "kernel_tool_cancelled"
	| "kernel_tool_loop_mismatch"
	| "tool_name_collision"
	| "tools_unavailable"
	| "invalid_tool_definition" {
	if (
		code === "kernel_tool_stale" ||
		code === "kernel_tool_missing" ||
		code === "kernel_tool_recursion" ||
		code === "kernel_tool_host_denied" ||
		code === "kernel_tool_cancelled" ||
		code === "kernel_tool_loop_mismatch" ||
		code === "tool_name_collision" ||
		code === "tools_unavailable" ||
		code === "invalid_tool_definition"
	) {
		return code;
	}
	return "kernel_tool_failed";
}
