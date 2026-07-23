import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import { JavaScriptKernel } from "../kernels/js/context-manager.ts";
import { marshalToolResult } from "../tool/image.ts";

const MAX_ACTIVE_CELLS = 4;
const MAX_PENDING_OUTPUT_CHARS = 100_000;
const MAX_TERMINAL_ERROR_CHARS = 4_096;
const RECURSIVE_TOOLS = new Set(["eval", "exec", "wait"]);

export type CodeModeCellState = "yielded" | "result" | "terminated" | "error" | "missing";

export interface CodeModeObservation {
	readonly cellId: string;
	readonly state: CodeModeCellState;
	readonly output: string;
	readonly error?: string;
}

export interface CodeModeRuntimeOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly parallelPoolWidth: number;
	readonly executeTool: AgentExecuteTool;
}

export class CodeModeCapacityError extends Error {
	readonly name = "CodeModeCapacityError";

	constructor() {
		super(`Code Mode supports at most ${MAX_ACTIVE_CELLS} active cells`);
	}
}

export class CodeModeSessionRuntime {
	readonly #options: CodeModeRuntimeOptions;
	readonly #cells = new Map<string, CodeModeCell>();
	#nextCell = 0;
	#disposed = false;

	constructor(options: CodeModeRuntimeOptions) {
		this.#options = options;
	}

	async execute(code: string, yieldTimeMs: number, signal: AbortSignal | undefined): Promise<CodeModeObservation> {
		this.#assertActive();
		const cellId = `exec-${++this.#nextCell}`;
		if (signal?.aborted) return { cellId, state: "terminated", output: "" };
		if (this.#cells.size >= MAX_ACTIVE_CELLS) throw new CodeModeCapacityError();
		const cell = new CodeModeCell(cellId, this.#options);
		this.#cells.set(cellId, cell);
		cell.start(code);
		const observation = await cell.observe(yieldTimeMs, signal);
		this.#releaseIfTerminal(observation);
		return observation;
	}

	async wait(
		cellId: string,
		yieldTimeMs: number,
		terminate: boolean,
		signal: AbortSignal | undefined,
	): Promise<CodeModeObservation> {
		const cell = this.#cells.get(cellId);
		if (cell === undefined) return { cellId, state: "missing", output: "" };
		const observation = terminate ? await cell.terminate() : await cell.observe(yieldTimeMs, signal);
		this.#releaseIfTerminal(observation);
		return observation;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const cells = [...this.#cells.values()];
		this.#cells.clear();
		await Promise.all(cells.map((cell) => cell.terminate()));
	}

	#releaseIfTerminal(observation: CodeModeObservation): void {
		if (observation.state !== "yielded") this.#cells.delete(observation.cellId);
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Code Mode session has been disposed");
	}
}

class CodeModeCell {
	readonly #id: string;
	readonly #options: CodeModeRuntimeOptions;
	readonly #kernel: JavaScriptKernel;
	readonly #abort = new AbortController();
	#output = "";
	#outputTruncated = false;
	#completion: Promise<void> | undefined;
	#state: "running" | "result" | "terminated" | "error" = "running";
	#error: string | undefined;

	constructor(id: string, options: CodeModeRuntimeOptions) {
		this.#id = id;
		this.#options = options;
		this.#kernel = new JavaScriptKernel({
			sessionId: `${options.sessionId}:${id}`,
			cwd: options.cwd,
			parallelPoolWidth: options.parallelPoolWidth,
			onMessage: (message) => this.#handleMessage(message),
		});
	}

	start(code: string): void {
		this.#completion = this.#kernel
			.run({ cellId: this.#id, code })
			.then((result) => {
				if (this.#state !== "running") return;
				if (result.ok) {
					this.#state = "result";
					if (result.valueRepr) this.#appendOutput(`${result.valueRepr}\n`);
					return;
				}
				this.#state = "error";
				this.#error = truncateTerminalError(result.error.message);
			})
			.catch((error: unknown) => {
				if (this.#state !== "running") return;
				this.#state = "error";
				this.#error = truncateTerminalError(error instanceof Error ? error.message : String(error));
			})
			.finally(async () => {
				if (this.#state !== "running") await this.#kernel.close();
			});
	}

	async observe(yieldTimeMs: number, signal: AbortSignal | undefined): Promise<CodeModeObservation> {
		if (signal?.aborted) return await this.terminate();
		if (this.#state !== "running") return this.#observation();
		const completion = this.#completion;
		if (completion === undefined) throw new Error("Code Mode cell has not started");
		const timeout = Math.max(1, Math.trunc(yieldTimeMs));
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const timedOut = new Promise<"yielded">((resolve) => {
			timer = setTimeout(() => resolve("yielded"), timeout);
		});
		const completed = completion.then(() => "completed" as const);
		const aborted = new Promise<"aborted">((resolve) => {
			if (!signal) return;
			abortListener = () => resolve("aborted");
			signal.addEventListener("abort", abortListener, { once: true });
		});
		try {
			const outcome = await Promise.race([completed, timedOut, aborted]);
			if (outcome === "aborted") return await this.terminate();
			return this.#observation();
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (abortListener && signal) signal.removeEventListener("abort", abortListener);
		}
	}

	async terminate(): Promise<CodeModeObservation> {
		if (this.#state === "terminated") return this.#observation();
		if (this.#state === "result" || this.#state === "error") return this.#observation();
		this.#state = "terminated";
		this.#abort.abort(new Error("Code Mode cell terminated"));
		try {
			await this.#kernel.interrupt("Code Mode cell terminated");
		} finally {
			await this.#kernel.close();
		}
		return this.#observation();
	}

	#handleMessage(message: KernelToHostMessage): void {
		if (message.type === "text") {
			this.#appendOutput(message.data);
			return;
		}
		if (message.type === "display") {
			this.#appendOutput(`[display ${message.mimeType}]\n`);
			return;
		}
		if (message.type === "tool-call") void this.#invokeTool(message);
	}

	async #invokeTool(message: Extract<KernelToHostMessage, { type: "tool-call" }>): Promise<void> {
		if (RECURSIVE_TOOLS.has(message.toolName)) {
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: `recursive Code Mode tool "${message.toolName}" is not allowed` },
			});
			return;
		}
		if (this.#options.executeTool.isToolAvailable?.(message.toolName) === false) {
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: `nested tool "${message.toolName}" is not active` },
			});
			return;
		}
		try {
			const result = await this.#options.executeTool(message.toolName, message.args, { signal: this.#abort.signal });
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: true,
				value: marshalToolResult(result),
			});
		} catch (error) {
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	#observation(): CodeModeObservation {
		let output = this.#output;
		this.#output = "";
		if (this.#outputTruncated) {
			output += "\n[output truncated]\n";
			this.#outputTruncated = false;
		}
		if (this.#state === "running") return { cellId: this.#id, state: "yielded", output };
		if (this.#state === "terminated") return { cellId: this.#id, state: "terminated", output };
		if (this.#state === "error") {
			const error = this.#error ?? "Code Mode cell failed";
			if (output !== "") output += output.endsWith("\n") ? error : `\n${error}`;
			else output = error;
			return { cellId: this.#id, state: "error", output, error };
		}
		return { cellId: this.#id, state: "result", output };
	}

	#appendOutput(value: string): void {
		const remaining = MAX_PENDING_OUTPUT_CHARS - this.#output.length;
		if (remaining <= 0) {
			this.#outputTruncated = true;
			return;
		}
		if (value.length > remaining) {
			this.#output += value.slice(0, remaining);
			this.#outputTruncated = true;
			return;
		}
		this.#output += value;
	}
}

function truncateTerminalError(message: string): string {
	if (message.length <= MAX_TERMINAL_ERROR_CHARS) return message;
	return `${message.slice(0, MAX_TERMINAL_ERROR_CHARS)}\n[error truncated]`;
}
