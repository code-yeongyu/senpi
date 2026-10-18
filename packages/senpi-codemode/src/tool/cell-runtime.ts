import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelMemoryReport } from "../bridge/memory-protocol.ts";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { formatModelTruncationNotice } from "../output/output-meta.ts";
import { DEFAULT_MAX_BYTES, TailLineRing } from "../output/streaming-output.ts";
import type { EvalToolCallMetric } from "./call-capture.ts";
import { type EvalImageResizer, EvalOutputCollector, type EvalOutputResult } from "./image.ts";
import type {
	EvalKernelState,
	EvalMemoryDetails,
	EvalRuntimeInfo,
	EvalStatusEvent,
	EvalToolDetails,
	EvalToolInput,
} from "./types.ts";

const LIVE_UPDATE_LINES = 8;
/** Same cadence as the core bash tool's streaming updates (BASH_UPDATE_THROTTLE_MS). */
const LIVE_OUTPUT_UPDATE_THROTTLE_MS = 100;

type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
type DisplayMessage = Extract<KernelToHostMessage, { type: "display" }>;
type ToolCall = EvalToolDetails["toolCalls"] extends readonly (infer Item)[] ? Item : never;

export interface CellState {
	readonly input: EvalToolInput;
	readonly runtime?: EvalRuntimeInfo;
	readonly startedAt: number;
	runStartedAt?: number | undefined;
	queuedBehind?: readonly string[] | undefined;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly toolCalls: ToolCall[];
	readonly toolCallMetrics: EvalToolCallMetric[];
	readonly pendingBridgeCalls: Promise<void>[];
	readonly statusEvents: EvalStatusEvent[];
	active: boolean;
	output: string;
	phase: string | undefined;
	error: string | undefined;
	durationMs: number;
	status: "pending" | "queued" | "running" | "complete" | "error";
}

export interface CellResultBuilderOptions {
	readonly artifactPath?: string;
	readonly headBytes: number;
	readonly imageResizer?: EvalImageResizer;
	readonly maxColumns: number;
	readonly model: ExtensionContext["model"];
	readonly state: CellState;
}

export class CellResultBuilder {
	readonly #output: EvalOutputCollector;
	readonly #state: CellState;
	#memory: KernelMemoryReport | undefined;
	#restartNotice: string | undefined;
	#kernelState: EvalKernelState | undefined;
	readonly #liveLines = new TailLineRing({ maxBytes: DEFAULT_MAX_BYTES * 2, maxLines: LIVE_UPDATE_LINES });
	#lastOutputUpdateAt = 0;
	#outputUpdateTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: CellResultBuilderOptions) {
		this.#state = options.state;
		this.#output = new EvalOutputCollector({
			headBytes: options.headBytes,
			maxColumns: options.maxColumns,
			model: options.model,
			...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
			...(options.imageResizer === undefined ? {} : { imageResizer: options.imageResizer }),
			onChunk: (chunk) => {
				this.#liveLines.append(chunk);
				this.#scheduleOutputUpdate();
			},
		});
		if (options.state.status !== "queued") options.state.status = "running";
		this.emitUpdate(false);
	}

	push(text: string): void {
		this.#output.push(text);
	}

	display(message: DisplayMessage): void {
		this.#output.display(message);
	}

	setPhase(title: string): void {
		this.#state.phase = title;
		this.emitUpdate(false);
	}

	async finalize(result: KernelResult): Promise<AgentToolResult<EvalToolDetails>> {
		this.#state.durationMs = result.durationMs;
		this.#memory = result.memory;
		this.#restartNotice = result.notice;
		this.#kernelState = result.kernelState;
		if (result.ok) {
			if (result.valueRepr) this.#output.pushValue(`${result.valueRepr}\n`);
			this.#state.status = "complete";
		} else {
			this.#state.error = result.error.message;
			this.#output.push(`${result.error.message}\n`);
			this.#state.status = "error";
		}
		return await this.#finish(!result.ok);
	}

	async finalizeCancellation(error: Error): Promise<AgentToolResult<EvalToolDetails>> {
		this.#state.error = error.message;
		this.#output.push(`${error.message}\n`);
		this.#state.status = "error";
		return await this.#finish(true);
	}

	async flushOutput(): Promise<void> {
		await this.#output.flush();
	}

	liveResult(): AgentToolResult<EvalToolDetails> {
		this.#state.output = this.#output.cellTailText();
		return {
			content: [{ type: "text", text: this.#liveUpdateText() }],
			details: this.#details(undefined, this.#state.status === "error"),
		};
	}

	emitUpdate(isError: boolean): void {
		if (!this.#state.active) return;
		this.#state.onUpdate?.({
			content: [{ type: "text", text: this.#liveUpdateText() }],
			details: this.#details(undefined, isError),
		});
	}

	#scheduleOutputUpdate(): void {
		const delay = LIVE_OUTPUT_UPDATE_THROTTLE_MS - (Date.now() - this.#lastOutputUpdateAt);
		if (delay <= 0) {
			this.#clearOutputUpdateTimer();
			this.#emitOutputUpdate();
			return;
		}
		this.#outputUpdateTimer ??= setTimeout(() => {
			this.#outputUpdateTimer = undefined;
			this.#emitOutputUpdate();
		}, delay);
	}

	#emitOutputUpdate(): void {
		this.#lastOutputUpdateAt = Date.now();
		this.#state.output = this.#output.cellTailText();
		this.emitUpdate(false);
	}

	#clearOutputUpdateTimer(): void {
		if (this.#outputUpdateTimer === undefined) return;
		clearTimeout(this.#outputUpdateTimer);
		this.#outputUpdateTimer = undefined;
	}

	async #finish(isError: boolean): Promise<AgentToolResult<EvalToolDetails>> {
		this.#clearOutputUpdateTimer();
		const output = await this.#output.finish();
		this.#state.output = output.output;
		const details = this.#details(output, isError);
		this.emitUpdate(isError);
		const shown =
			output.output ||
			(output.images.length > 0
				? `(displayed ${output.images.length} image${output.images.length === 1 ? "" : "s"}; no text output)`
				: "(no output)");
		const text = output.meta === undefined ? shown : `${shown}\n${formatModelTruncationNotice(output.meta)}`;
		const noticeParts = [this.#restartNotice, this.#memory?.notice].flatMap((notice) =>
			notice === undefined ? [] : [{ type: "text" as const, text: notice }],
		);
		return { content: [{ type: "text", text }, ...noticeParts, ...output.images], details };
	}

	#details(output: EvalOutputResult | undefined, isError: boolean): EvalToolDetails {
		const statusEvents = this.#state.statusEvents.length > 0 ? [...this.#state.statusEvents] : undefined;
		return {
			language: this.#state.input.language,
			languages: [this.#state.input.language],
			...(this.#state.runtime === undefined ? {} : { runtime: this.#state.runtime }),
			...(this.#state.input.summary === undefined ? {} : { summary: this.#state.input.summary }),
			durationMs: this.#state.durationMs,
			wallDurationMs: Math.max(0, Date.now() - this.#state.startedAt),
			toolCallCount: this.#state.toolCallMetrics.length,
			toolCalls: [...this.#state.toolCalls],
			truncated: output?.truncated ?? false,
			...(isError ? { isError: true } : {}),
			...(this.#state.phase === undefined ? {} : { phase: this.#state.phase }),
			cells: [
				{
					index: 0,
					...(this.#state.input.summary === undefined ? {} : { summary: this.#state.input.summary }),
					code: this.#state.input.code,
					language: this.#state.input.language,
					...(this.#state.runtime === undefined ? {} : { runtime: this.#state.runtime }),
					output: this.#state.output,
					status: this.#state.status,
					durationMs: this.#state.durationMs,
					...(this.#state.status === "queued"
						? {}
						: { startedAt: this.#state.runStartedAt ?? this.#state.startedAt }),
					...(this.#state.queuedBehind === undefined ? {} : { queuedBehind: this.#state.queuedBehind }),
					...(statusEvents === undefined ? {} : { statusEvents }),
					...(output?.hasMarkdown ? { hasMarkdown: true } : {}),
				},
			],
			...(statusEvents === undefined ? {} : { statusEvents }),
			...(output === undefined || output.jsonOutputs.length === 0 ? {} : { jsonOutputs: output.jsonOutputs }),
			...(output?.notice === undefined ? {} : { notice: output.notice }),
			...(output?.meta === undefined ? {} : { meta: output.meta }),
			...(output === undefined || this.#memory === undefined ? {} : { memory: memoryDetails(this.#memory) }),
			...(this.#kernelState === undefined ? {} : { kernelState: this.#kernelState }),
		};
	}

	#liveUpdateText(): string {
		if (this.#state.status === "queued" && this.#state.queuedBehind !== undefined) {
			return this.#state.queuedBehind.length === 0
				? `waiting for the ${this.#state.input.language} kernel to be ready`
				: `queued behind ${this.#state.queuedBehind.join(", ")} in the ${this.#state.input.language} kernel`;
		}
		const summary = this.#state.input.summary === undefined ? "" : ` ${this.#state.input.summary}`;
		const output = this.#liveLines.text();
		return `1/1 cells ${this.#state.status}\n[1] ${this.#state.input.language}${summary} ${this.#state.status}${output.length === 0 ? "" : `\n${output}`}`;
	}
}

function memoryDetails(report: KernelMemoryReport): EvalMemoryDetails {
	const { notice: _notice, ...details } = report;
	return details;
}
