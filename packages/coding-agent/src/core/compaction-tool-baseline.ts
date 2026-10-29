/**
 * The active tool names a compaction claim started with (senpi#4706).
 *
 * A summary is prepared against the active tool set, so it goes stale only when
 * a tool that set held is revoked. Tools added while the compaction runs, such
 * as an MCP server finishing its connect after startup, are absent from the
 * history being summarized and leave the summary valid.
 */
export interface CompactionToolBaseline {
	readonly claim: AbortController;
	readonly names: ReadonlySet<string>;
}

export function captureCompactionToolBaseline(
	claim: AbortController,
	activeTools: readonly { readonly name: string }[],
): CompactionToolBaseline {
	return { claim, names: new Set(activeTools.map((tool) => tool.name)) };
}

/**
 * Whether changing the active tools to `nextActiveToolNames` must cancel and
 * invalidate compaction work. With no live compaction claim every change does,
 * which also retires summaries prepared ahead of time against the old set.
 */
export function toolChangeInvalidatesCompaction(
	baseline: CompactionToolBaseline | undefined,
	nextActiveToolNames: readonly string[],
): boolean {
	if (baseline === undefined) return true;
	const next = new Set(nextActiveToolNames);
	for (const name of baseline.names) {
		if (!next.has(name)) return true;
	}
	return false;
}
