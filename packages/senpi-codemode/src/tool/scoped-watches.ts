import { SCOPE_MONITOR_OP } from "../bridge/reserved.ts";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import type { EvalStatusEvent } from "./types.ts";

const ENDED_WATCH_RE = /^No terminal session found with id/u;

/**
 * The watches a JS cell's `scope().monitor()` still holds. A stopped or timed-out cell cannot call tools any more, so
 * its scope cannot stop them; the host does, when the cell settles without a result.
 */
export class ScopedWatches {
	readonly #held = new Set<string>();

	/** Consumes a scope-monitor report; false for every other status event. */
	observe(event: EvalStatusEvent): boolean {
		if (event.op !== SCOPE_MONITOR_OP) return false;
		const bashId = event.bashId;
		if (typeof bashId !== "string") return true;
		if (event.held === true) this.#held.add(bashId);
		else this.#held.delete(bashId);
		return true;
	}

	async stopHeld(executeTool: AgentExecuteTool): Promise<readonly string[]> {
		const failures: string[] = [];
		for (const bashId of this.#held) {
			try {
				const result: unknown = await executeTool("kill_bash", { bash_id: bashId });
				const text = resultText(result);
				if (isRecord(result) && result.isError === true && !ENDED_WATCH_RE.test(text)) {
					failures.push(`scoped watch ${bashId} did not stop: ${text}`);
				}
			} catch (error) {
				failures.push(
					`scoped watch ${bashId} did not stop: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		this.#held.clear();
		return failures;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object";
}

function resultText(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result.content)) return "";
	return result.content
		.map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
		.join("");
}
