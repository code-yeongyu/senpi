export class TurnDiffTracker {
	private readonly fileDiffs = new Map<string, string>();
	private emitted = "";

	update(toolId: string, diff: string, sourceOrder: Iterable<string>): string | undefined {
		if (!diff) return undefined;
		this.fileDiffs.set(toolId, diff);
		const cumulative = Array.from(sourceOrder, (id) => this.fileDiffs.get(id) ?? "").join("");
		if (cumulative === this.emitted) return undefined;
		this.emitted = cumulative;
		return cumulative;
	}
}
