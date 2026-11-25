import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ACP_CLIENT_INFO, BRIDGE_TOOL_PREFIX } from "./constants.ts";

const STDERR_TAIL_BYTES = 16 * 1024;
const MAX_LINE_CHARACTERS = 4 * 1024 * 1024;

export type AcpContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

export type AcpMcpServerConfig = {
	readonly type: "http";
	readonly name: string;
	readonly url: string;
	readonly headers?: readonly { readonly name: string; readonly value: string }[];
};

export type AcpConfigSelectOption = {
	readonly value: string;
	readonly name?: string;
};

export type AcpConfigOption = {
	readonly id: string;
	readonly name?: string;
	readonly category?: string;
	readonly type?: string;
	readonly currentValue?: string;
	readonly options?: readonly AcpConfigSelectOption[];
};

export type AcpAvailableModel = {
	readonly modelId: string;
	readonly name?: string;
};

export type AcpInitializeResult = {
	readonly protocolVersion?: number;
	readonly agentCapabilities?: Record<string, unknown>;
	readonly agentInfo?: { readonly name?: string; readonly version?: string };
	readonly authMethods?: readonly { readonly id: string; readonly name?: string; readonly description?: string }[];
};

export type AcpSessionResult = {
	readonly sessionId: string;
	readonly models?: {
		readonly availableModels?: readonly AcpAvailableModel[];
		readonly currentModelId?: string;
	};
	readonly configOptions?: readonly AcpConfigOption[];
};

export type AcpSetConfigOptionResult = {
	readonly configOptions?: readonly AcpConfigOption[];
};

export type AcpPromptUsage = {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cachedReadTokens?: number;
	readonly cachedWriteTokens?: number;
	readonly thoughtTokens?: number;
	readonly totalTokens?: number;
};

export type AcpPromptResult = {
	readonly stopReason: string;
	readonly usage?: AcpPromptUsage;
};

export type AcpSessionUpdatePayload = {
	readonly sessionUpdate?: string;
	readonly content?: { readonly type?: string; readonly text?: string };
	readonly toolCallId?: string;
	readonly name?: string;
	readonly title?: string;
	readonly status?: string;
	readonly kind?: string;
	readonly used?: number;
	readonly size?: number;
	readonly configOptions?: readonly AcpConfigOption[];
	readonly [key: string]: unknown;
};

export type AcpSessionUpdateNotification = {
	readonly sessionId?: string;
	readonly update?: AcpSessionUpdatePayload;
};

export type AcpPermissionOption = {
	readonly optionId: string;
	readonly name?: string;
	readonly kind?: string;
};

export type AcpPermissionRequest = {
	readonly sessionId?: string;
	readonly toolCall?: {
		readonly toolCallId?: string;
		readonly name?: string;
		readonly title?: string;
		readonly kind?: string;
	};
	readonly options?: readonly AcpPermissionOption[];
};

export type AcpPermissionDecision = {
	readonly allowed: boolean;
	readonly toolName: string;
	readonly response: {
		readonly outcome: { readonly outcome: "selected"; readonly optionId: string } | { readonly outcome: "cancelled" };
	};
};

export class AcpRpcError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(message: string, code: number, data?: unknown) {
		super(message);
		this.name = "AcpRpcError";
		this.code = code;
		this.data = data;
	}
}

type PendingRequest = {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout> | undefined;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: (() => void) | undefined;
};

export type AcpClientCallbacks = {
	readonly onUpdate?: (notification: AcpSessionUpdateNotification) => void;
	readonly onServerRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
	readonly onExit?: (code: number | null, stderrTail: string) => void;
};

export type AcpRequestOptions = {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
};

export function extractPermissionToolName(params: AcpPermissionRequest): string {
	const name = params.toolCall?.name?.trim();
	if (name) return name;
	const title = params.toolCall?.title?.trim() ?? "";
	const mcpMatch = /\b(mcp_[^\s]+)/.exec(title);
	if (mcpMatch?.[1]) return mcpMatch[1];
	return title || "unknown";
}

export function decidePermissionOutcome(
	params: AcpPermissionRequest,
	bridgePrefix = BRIDGE_TOOL_PREFIX,
): AcpPermissionDecision {
	const toolName = extractPermissionToolName(params);
	const options = params.options ?? [];
	const isBridgeTool = toolName.startsWith(bridgePrefix);

	if (isBridgeTool) {
		const allowOpt =
			options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always") ?? options[0];
		return {
			allowed: true,
			toolName,
			response: allowOpt
				? { outcome: { outcome: "selected", optionId: allowOpt.optionId } }
				: { outcome: { outcome: "cancelled" } },
		};
	}

	const rejectOpt = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
	return {
		allowed: false,
		toolName,
		response: rejectOpt
			? { outcome: { outcome: "selected", optionId: rejectOpt.optionId } }
			: { outcome: { outcome: "cancelled" } },
	};
}

export class AcpClient {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #callbacks: AcpClientCallbacks;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #decoder = new TextDecoder();
	#nextId = 1;
	#lineBuffer = "";
	#discarding = false;
	#closed = false;
	#exitCode: number | null = null;
	#stderrTail = "";

	constructor(child: ChildProcessWithoutNullStreams, callbacks: AcpClientCallbacks = {}) {
		this.#child = child;
		this.#callbacks = callbacks;
		this.#wire();
	}

	get closed(): boolean {
		return this.#closed;
	}

	get exitCode(): number | null {
		return this.#exitCode;
	}

	get stderrTail(): string {
		return this.#stderrTail;
	}

	request<T>(method: string, params: Record<string, unknown> = {}, options: AcpRequestOptions = {}): Promise<T> {
		if (this.#closed) {
			return Promise.reject(
				new Error(`ACP process already exited (code ${this.#exitCode ?? "null"}): ${this.#stderrTail}`),
			);
		}
		if (options.signal?.aborted) {
			return Promise.reject(abortError(options.signal));
		}

		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const cleanup = (entry: PendingRequest) => {
				if (entry.timer !== undefined) clearTimeout(entry.timer);
				if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
			};

			const timer =
				options.timeoutMs !== undefined && options.timeoutMs > 0
					? setTimeout(() => {
							if (settled) return;
							settled = true;
							const entry = this.#pending.get(id);
							if (entry) {
								this.#pending.delete(id);
								cleanup(entry);
							}
							reject(new Error(`ACP request ${method} timed out after ${options.timeoutMs}ms`));
						}, options.timeoutMs)
					: undefined;
			timer?.unref?.();

			const onAbort = options.signal
				? () => {
						if (settled) return;
						settled = true;
						const entry = this.#pending.get(id);
						if (entry) {
							this.#pending.delete(id);
							cleanup(entry);
						}
						reject(abortError(options.signal));
					}
				: undefined;

			const entry: PendingRequest = {
				method,
				resolve: (value) => {
					if (settled) return;
					settled = true;
					cleanup(entry);
					resolve(value as T);
				},
				reject: (error) => {
					if (settled) return;
					settled = true;
					cleanup(entry);
					reject(error);
				},
				timer,
				signal: options.signal,
				onAbort,
			};

			this.#pending.set(id, entry);
			if (options.signal && onAbort) {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
			try {
				this.#child.stdin.write(payload, (error) => {
					if (!error) return;
					if (this.#pending.delete(id)) entry.reject(error);
				});
			} catch (error) {
				if (this.#pending.delete(id)) {
					entry.reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
	}

	notify(method: string, params: Record<string, unknown> = {}): void {
		if (this.#closed) return;
		const payload = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
		try {
			this.#child.stdin.write(payload);
		} catch {
			// Best-effort notification on shutdown/cancel races.
		}
	}

	initialize(options: AcpRequestOptions = {}): Promise<AcpInitializeResult> {
		return this.request<AcpInitializeResult>(
			"initialize",
			{
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: ACP_CLIENT_INFO,
			},
			options,
		);
	}

	authenticate(methodId: string, options: AcpRequestOptions = {}): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>("authenticate", { methodId }, options);
	}

	newSession(
		params: {
			readonly cwd: string;
			readonly mcpServers: readonly AcpMcpServerConfig[];
			readonly systemPromptAppend: string;
		},
		options: AcpRequestOptions = {},
	): Promise<AcpSessionResult> {
		return this.request<AcpSessionResult>(
			"session/new",
			{
				cwd: params.cwd,
				mcpServers: params.mcpServers,
				_meta: {
					antigravity: {
						systemPrompt: { append: params.systemPromptAppend },
					},
				},
			},
			options,
		);
	}

	resumeSession(
		params: {
			readonly sessionId: string;
			readonly cwd: string;
			readonly mcpServers: readonly AcpMcpServerConfig[];
			readonly systemPromptAppend: string;
		},
		options: AcpRequestOptions = {},
	): Promise<AcpSessionResult> {
		return this.request<AcpSessionResult>(
			"session/resume",
			{
				sessionId: params.sessionId,
				cwd: params.cwd,
				mcpServers: params.mcpServers,
				_meta: {
					antigravity: {
						systemPrompt: { append: params.systemPromptAppend },
					},
				},
			},
			options,
		);
	}

	closeSession(sessionId: string, options: AcpRequestOptions = {}): Promise<Record<string, unknown>> {
		return this.request<Record<string, unknown>>("session/close", { sessionId }, options);
	}

	setConfigOption(
		sessionId: string,
		configId: string,
		value: string,
		options: AcpRequestOptions = {},
	): Promise<AcpSetConfigOptionResult> {
		return this.request<AcpSetConfigOptionResult>(
			"session/set_config_option",
			{ sessionId, configId, value },
			options,
		);
	}

	prompt(
		sessionId: string,
		prompt: readonly AcpContentBlock[],
		options: AcpRequestOptions = {},
	): Promise<AcpPromptResult> {
		return this.request<AcpPromptResult>("session/prompt", { sessionId, prompt }, options);
	}

	cancel(sessionId: string): void {
		this.notify("session/cancel", { sessionId });
	}

	#wire(): void {
		this.#child.stdout.on("data", (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
			this.#pushText(text);
		});
		this.#child.stderr.on("data", (chunk: Buffer) => {
			this.#stderrTail = boundedTail(this.#stderrTail, chunk);
		});
		this.#child.once("error", (error) => {
			this.#stderrTail = boundedTail(this.#stderrTail, Buffer.from(error.message, "utf8"));
		});
		this.#child.once("close", (code) => {
			const tail = this.#decoder.decode();
			if (tail) this.#pushText(tail);
			if (!this.#discarding && this.#lineBuffer.trim()) {
				const line = this.#lineBuffer.endsWith("\r") ? this.#lineBuffer.slice(0, -1) : this.#lineBuffer;
				this.#lineBuffer = "";
				this.#handleLine(line);
			}
			this.#closed = true;
			this.#exitCode = code;
			const exitErr = new Error(`agy acp exited unexpectedly (code ${code ?? "null"}): ${this.#stderrTail}`);
			for (const entry of [...this.#pending.values()]) {
				entry.reject(exitErr);
			}
			this.#pending.clear();
			this.#callbacks.onExit?.(code, this.#stderrTail);
		});
	}

	#pushText(text: string): void {
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i += 1) {
			const part = parts[i]!;
			if (this.#discarding) {
				if (i < parts.length - 1) this.#discarding = false;
				continue;
			}
			if (this.#lineBuffer.length + part.length > MAX_LINE_CHARACTERS) {
				this.#lineBuffer = "";
				this.#discarding = i === parts.length - 1;
				continue;
			}
			this.#lineBuffer += part;
			if (i < parts.length - 1) {
				const line = this.#lineBuffer.endsWith("\r") ? this.#lineBuffer.slice(0, -1) : this.#lineBuffer;
				this.#lineBuffer = "";
				if (line.trim()) this.#handleLine(line);
			}
		}
	}

	#handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;

		const hasId = Object.hasOwn(parsed, "id") && parsed.id !== null && parsed.id !== undefined;
		const method = typeof parsed.method === "string" ? parsed.method : undefined;

		if (hasId && method === undefined) {
			const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
			const entry = this.#pending.get(id);
			if (!entry) return;
			this.#pending.delete(id);
			if (isRecord(parsed.error)) {
				const code = typeof parsed.error.code === "number" ? parsed.error.code : -32603;
				const message = typeof parsed.error.message === "string" ? parsed.error.message : "ACP RPC error";
				entry.reject(new AcpRpcError(message, code, parsed.error.data));
				return;
			}
			entry.resolve(parsed.result);
			return;
		}

		if (hasId && method !== undefined) {
			const id = parsed.id;
			const params = isRecord(parsed.params) ? parsed.params : {};
			void this.#handleServerRequest(id, method, params);
			return;
		}

		if (!hasId && method === "session/update") {
			const params = isRecord(parsed.params) ? (parsed.params as AcpSessionUpdateNotification) : undefined;
			if (params !== undefined) this.#callbacks.onUpdate?.(params);
		}
	}

	async #handleServerRequest(id: unknown, method: string, params: Record<string, unknown>): Promise<void> {
		if (!this.#callbacks.onServerRequest) {
			this.#writeJson({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported request: ${method}` } });
			return;
		}
		try {
			const result = await this.#callbacks.onServerRequest(method, params);
			this.#writeJson({ jsonrpc: "2.0", id, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#writeJson({ jsonrpc: "2.0", id, error: { code: -32603, message } });
		}
	}

	#writeJson(payload: unknown): void {
		if (this.#closed) return;
		try {
			this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch {
			// Ignore write errors during shutdown.
		}
	}
}

function boundedTail(current: string, chunk: Buffer): string {
	const bytes = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
	return bytes.subarray(Math.max(0, bytes.length - STDERR_TAIL_BYTES)).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
