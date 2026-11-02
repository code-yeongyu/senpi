import type { KernelPreludeContribution } from "@code-yeongyu/senpi";

/** What a kernel applies before a cell: contributions to (re)install and exports whose tool is no longer active. */
export interface KernelPreludePlan {
	readonly install: readonly KernelPreludeContribution[];
	readonly remove: readonly string[];
}

/** Remembers the exports one kernel was last told to hold, so a deactivated tool's globals are removed. */
export class KernelPreludeTracker {
	#installed: ReadonlySet<string> = new Set();

	plan(contributions: readonly KernelPreludeContribution[]): KernelPreludePlan {
		const active = new Set(contributions.flatMap((contribution) => contribution.exports));
		const remove = [...this.#installed].filter((name) => !active.has(name));
		this.#installed = active;
		return { install: contributions, remove };
	}
}
