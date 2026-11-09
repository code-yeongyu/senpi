import type { AgentToolResult } from "@code-yeongyu/senpi";
import { DEFAULT_MAX_BYTES, truncateTailBytes } from "../output/streaming-output.ts";

/** Where a running cell receives the partial results of the tools it calls, so they stream live (#6167). */
export interface CellToolUpdateSink {
	nestedToolUpdate(callId: string, partial: AgentToolResult<unknown>): void;
	nestedToolSettled(callId: string): void;
}

/**
 * The latest partial output of each tool call a cell is still awaiting. It joins the cell's live view only: the
 * value the tool returns to the cell and the cell's own result never contain it.
 */
export class NestedToolOutput {
	readonly #byCall = new Map<string, string>();
	/** Settled calls' last text, still on screen until the cell's own output or its completion replaces it (#6257). */
	readonly #settled = new Map<string, string>();

	/** Keeps the call's newest partial; false when it adds no new text. */
	update(callId: string, partial: AgentToolResult<unknown>): boolean {
		const text = partial.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		if (text.length === 0 || this.#byCall.get(callId) === text) return false;
		this.#byCall.set(callId, text);
		return true;
	}

	/**
	 * Marks a call settled; false when it never showed output. Its last text stays in the live view until
	 * `releaseSettled` (the cell's own next output) or `clear` (the cell finished), so the user never sees the
	 * running cell with those lines gone and nothing in their place (#6257).
	 */
	drop(callId: string): boolean {
		const text = this.#byCall.get(callId);
		if (text === undefined) return false;
		this.#byCall.delete(callId);
		this.#settled.set(callId, text);
		return true;
	}

	/** Removes every settled call's held text; false when none was held. */
	releaseSettled(): boolean {
		if (this.#settled.size === 0) return false;
		this.#settled.clear();
		return true;
	}

	clear(): void {
		this.#byCall.clear();
		this.#settled.clear();
	}

	appendTo(output: string): string {
		let combined = output;
		for (const text of [...this.#settled.values(), ...this.#byCall.values()]) {
			const tail = truncateTailBytes(text, DEFAULT_MAX_BYTES).text;
			combined = combined.length === 0 || combined.endsWith("\n") ? `${combined}${tail}` : `${combined}\n${tail}`;
		}
		return combined;
	}

	/** Like `appendTo`, kept to the last `maxLines` lines; `output` is returned untouched while no call shows output. */
	appendLines(output: string, maxLines: number): string {
		if (this.#byCall.size === 0 && this.#settled.size === 0) return output;
		const combined = this.appendTo(output);
		const hasTrailingNewline = combined.endsWith("\n");
		const lines = combined.split("\n");
		if (hasTrailingNewline) lines.pop();
		return `${lines.slice(-maxLines).join("\n")}${hasTrailingNewline ? "\n" : ""}`;
	}
}
