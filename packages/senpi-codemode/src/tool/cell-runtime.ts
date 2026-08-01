import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { type EvalImageResizer, EvalOutputCollector, type EvalOutputResult } from "./image.ts";
import type { EvalStatusEvent, EvalToolDetails, EvalToolInput } from "./types.ts";

type KernelResult = Extract<KernelToHostMessage, { type: "result" }>;
type DisplayMessage = Extract<KernelToHostMessage, { type: "display" }>;
type ToolCall = EvalToolDetails["toolCalls"] extends readonly (infer Item)[] ? Item : never;

export interface CellState {
	readonly input: EvalToolInput;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly toolCalls: ToolCall[];
	readonly pendingBridgeCalls: Promise<void>[];
	readonly statusEvents: EvalStatusEvent[];
	active: boolean;
	output: string;
	phase: string | undefined;
	durationMs: number;
	status: "pending" | "running" | "complete" | "error";
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

	constructor(options: CellResultBuilderOptions) {
		this.#state = options.state;
		this.#output = new EvalOutputCollector({
			headBytes: options.headBytes,
			maxColumns: options.maxColumns,
			model: options.model,
			...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
			...(options.imageResizer === undefined ? {} : { imageResizer: options.imageResizer }),
			onChunk: (_aggregate, cell) => {
				options.state.output = cell;
				this.emitUpdate(false);
			},
		});
		options.state.status = "running";
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
		if (result.ok) {
			if (result.valueRepr) this.#output.push(`${result.valueRepr}\n`);
			this.#state.status = "complete";
		} else {
			this.#output.push(`${result.error.message}\n`);
			this.#state.status = "error";
		}
		return await this.#finish(!result.ok);
	}

	async finalizeCancellation(error: Error): Promise<AgentToolResult<EvalToolDetails>> {
		this.#output.push(`${error.message}\n`);
		this.#state.status = "error";
		return await this.#finish(true);
	}

	async flushOutput(): Promise<void> {
		await this.#output.flush();
	}

	liveResult(): AgentToolResult<EvalToolDetails> {
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

	async #finish(isError: boolean): Promise<AgentToolResult<EvalToolDetails>> {
		const output = await this.#output.finish();
		this.#state.output = output.output;
		const details = this.#details(output, isError);
		this.emitUpdate(isError);
		const text =
			output.output ||
			(output.images.length > 0
				? `(displayed ${output.images.length} image${output.images.length === 1 ? "" : "s"}; no text output)`
				: "(no output)");
		return { content: [{ type: "text", text }, ...output.images], details };
	}

	#details(output: EvalOutputResult | undefined, isError: boolean): EvalToolDetails {
		const statusEvents = this.#state.statusEvents.length > 0 ? [...this.#state.statusEvents] : undefined;
		return {
			language: this.#state.input.language,
			languages: [this.#state.input.language],
			...(this.#state.input.title === undefined ? {} : { title: this.#state.input.title }),
			durationMs: this.#state.durationMs,
			toolCalls: [...this.#state.toolCalls],
			truncated: output?.truncated ?? false,
			...(isError ? { isError: true } : {}),
			...(this.#state.phase === undefined ? {} : { phase: this.#state.phase }),
			cells: [
				{
					index: 0,
					...(this.#state.input.title === undefined ? {} : { title: this.#state.input.title }),
					code: this.#state.input.code,
					language: this.#state.input.language,
					output: this.#state.output,
					status: this.#state.status,
					durationMs: this.#state.durationMs,
					...(statusEvents === undefined ? {} : { statusEvents }),
					...(output?.hasMarkdown ? { hasMarkdown: true } : {}),
				},
			],
			...(statusEvents === undefined ? {} : { statusEvents }),
			...(output === undefined || output.jsonOutputs.length === 0 ? {} : { jsonOutputs: output.jsonOutputs }),
			...(output?.notice === undefined ? {} : { notice: output.notice }),
			...(output?.meta === undefined ? {} : { meta: output.meta }),
		};
	}

	#liveUpdateText(): string {
		const title = this.#state.input.title === undefined ? "" : ` ${this.#state.input.title}`;
		const aggregateOutput = this.#output.aggregateText();
		const outputLines = aggregateOutput.split("\n");
		const hasTrailingNewline = aggregateOutput.endsWith("\n");
		if (hasTrailingNewline) outputLines.pop();
		const output = `${outputLines.slice(-8).join("\n")}${hasTrailingNewline ? "\n" : ""}`;
		return `1/1 cells ${this.#state.status}\n[1] ${this.#state.input.language}${title} ${this.#state.status}${output.length === 0 ? "" : `\n${output}`}`;
	}
}
