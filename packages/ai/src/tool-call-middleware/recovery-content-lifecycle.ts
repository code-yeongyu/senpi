export type RecoveryContentKind = "text" | "thinking" | "toolCall";

type ActiveContent = { readonly innerIndex: number; readonly kind: RecoveryContentKind };

/** Validates the sequential provider content-event protocol in O(1). */
export class RecoveryContentLifecycle {
	private active: ActiveContent | null = null;
	private lastEndedInnerIndex = -1;

	canStart(innerIndex: number): boolean {
		return this.active === null && innerIndex > this.lastEndedInnerIndex;
	}

	start(innerIndex: number, kind: RecoveryContentKind): void {
		this.active = { innerIndex, kind };
	}

	isActive(innerIndex: number, kind: RecoveryContentKind): boolean {
		return this.active?.innerIndex === innerIndex && this.active.kind === kind;
	}

	end(innerIndex: number, kind: RecoveryContentKind): boolean {
		if (!this.isActive(innerIndex, kind)) return false;
		this.active = null;
		this.lastEndedInnerIndex = innerIndex;
		return true;
	}
}
