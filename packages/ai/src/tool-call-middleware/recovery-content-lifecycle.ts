export type RecoveryContentKind = "text" | "thinking" | "toolCall";

type ActiveContent = { readonly innerIndex: number; readonly kind: RecoveryContentKind };

/** Allows overlapping native calls while keeping text/thinking content sequential. */
export class RecoveryContentLifecycle {
	private active: ActiveContent | null = null;
	private readonly activeToolCalls = new Set<number>();
	private lastStartedInnerIndex = -1;

	canStart(innerIndex: number, kind: RecoveryContentKind): boolean {
		return (
			this.active === null &&
			innerIndex > this.lastStartedInnerIndex &&
			(kind === "toolCall" || this.activeToolCalls.size === 0)
		);
	}

	start(innerIndex: number, kind: RecoveryContentKind): void {
		this.lastStartedInnerIndex = innerIndex;
		if (kind === "toolCall") this.activeToolCalls.add(innerIndex);
		else this.active = { innerIndex, kind };
	}

	isActive(innerIndex: number, kind: RecoveryContentKind): boolean {
		if (kind === "toolCall") return this.activeToolCalls.has(innerIndex);
		return this.active?.innerIndex === innerIndex && this.active.kind === kind;
	}

	end(innerIndex: number, kind: RecoveryContentKind): boolean {
		if (!this.isActive(innerIndex, kind)) return false;
		if (kind === "toolCall") this.activeToolCalls.delete(innerIndex);
		else this.active = null;
		return true;
	}
}
