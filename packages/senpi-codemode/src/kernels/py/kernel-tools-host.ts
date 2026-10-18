import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import { kernelToolError } from "../js/kernel-tools-errors.ts";
import type {
	KernelToolsDescribeResult,
	KernelToolsInvokeOptions,
	KernelToolsInvokeRequest,
} from "../js/kernel-tools-types.ts";
import { KernelToolHostPump } from "../shared/kernel-tools-pump.ts";

export type KernelToolReplyEvent = {
	readonly requestId: string;
	readonly ok: boolean;
	readonly code?: string;
	readonly message?: string;
	readonly output?: string;
};

function replyEvent(message: Extract<KernelToHostMessage, { type: "kernel-tool-invoke-reply" }>): KernelToolReplyEvent {
	return {
		requestId: message.requestId,
		ok: message.ok,
		...(message.ok ? {} : { message: message.error.message }),
		...(!message.ok && message.error.code !== undefined ? { code: message.error.code } : {}),
		...(message.output === undefined ? {} : { output: message.output }),
	};
}

export type PeerKernelToolsDescribe = (names: readonly string[]) => Promise<KernelToolsDescribeResult> | undefined;

/** The host half of Python kernel tools: frames over the live transport, names, and generation fencing. */
export class PythonKernelTools {
	readonly #pump: KernelToolHostPump;
	readonly #peerDescribe: PeerKernelToolsDescribe | undefined;
	#names: readonly string[] = [];

	constructor(options: {
		readonly post: (message: HostToKernelMessage) => void;
		readonly isOpen: () => boolean;
		readonly peerDescribe?: PeerKernelToolsDescribe;
	}) {
		this.#pump = new KernelToolHostPump(options.post, options.isOpen);
		this.#peerDescribe = options.peerDescribe;
	}

	get events(): EventTarget {
		return this.#pump.events;
	}

	listNames(): readonly string[] {
		return this.#names;
	}

	consume(message: KernelToHostMessage): boolean {
		if (message.type === "kernel-tools-defined") {
			this.#names = [...message.names];
			return true;
		}
		if (message.type === "kernel-tool-invoke-reply") {
			// Published even when the waiter is gone (a cancelled call), so its explicit outcome stays observable.
			this.#pump.events.dispatchEvent(
				new CustomEvent<KernelToolReplyEvent>("kernelToolReply", { detail: replyEvent(message) }),
			);
		}
		return this.#pump.consume(message);
	}

	/** The interpreter is gone (restart, reset, close, death): its definitions and in-flight calls are too. */
	retire(reason: "kernel_tool_stale" | "tools_unavailable", message: string): void {
		this.#names = [];
		this.#pump.rejectAll(kernelToolError(reason, message));
	}

	async describe(names: readonly string[]): Promise<KernelToolsDescribeResult> {
		const own = await this.#pump.describe(names);
		const peer = await this.#peerDescribe?.(names)?.catch(() => undefined);
		if (!peer) return own;
		const definedInJs = new Set(peer.results.filter((entry) => entry.ok).map((entry) => entry.name));
		return {
			results: own.results.map((entry) =>
				entry.ok && definedInJs.has(entry.name)
					? {
							name: entry.name,
							ok: false,
							error: {
								code: "tool_name_collision",
								message: `Kernel tool ${entry.name} is defined in both js and py`,
							},
						}
					: entry,
			),
		};
	}

	async invoke(request: KernelToolsInvokeRequest, options?: AbortSignal | KernelToolsInvokeOptions): Promise<unknown> {
		return await this.#pump.invoke(request, options);
	}
}
