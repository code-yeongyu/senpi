import type { AgentToolResult } from "@code-yeongyu/senpi";
import { type CellDeadlineExpiry, CellDeadlines } from "./cell-deadlines.ts";
import type { EvalDetachedCellSnapshot, EvalDetachedCellState } from "./detached-cell-contract.ts";
import { detachedNotificationSpillPath } from "./detached-cell-notification.ts";
import type { EvalKernel, EvalToolDetails, EvalToolInput } from "./types.ts";

export type LiveResultProvider = () => AgentToolResult<EvalToolDetails>;

export type ManagedCell = {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly spillPath: string | undefined;
	readonly startedAtMs: number;
	readonly terminal: PromiseWithResolvers<EvalDetachedCellSnapshot>;
	state: EvalDetachedCellState;
	canDetach: boolean;
	wasDetached: boolean;
	kernel: EvalKernel | undefined;
	stateRetained: boolean | undefined;
	interruptNote: string | undefined;
	/** Holds the completion notification until the interrupt has reported whether kernel state survived. */
	interruptOutcome: PromiseWithResolvers<void> | undefined;
	liveResult: LiveResultProvider | undefined;
	terminalResult: AgentToolResult<EvalToolDetails> | undefined;
	notificationQueued: boolean;
	readonly deadlines: CellDeadlines;
	readonly hardLimitSeconds: number;
	readonly runBudgetSeconds: number;
	hardLimited: boolean;
	runBudgetExhausted: boolean;
	/** Foreground killer: the still-awaited CellExecution owns interrupting and rejecting its own call; bound from creation so a deadline firing during kernel boot still ends it. */
	onKill: ((error: Error) => void) | undefined;
};

export interface ManagedCellInit {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly artifactsDir: string | undefined;
	readonly now: () => number;
	readonly defaultHardLimitSeconds: number;
	readonly defaultRunBudgetSeconds: number;
	readonly onKill: ((error: Error) => void) | undefined;
	readonly onExpire: (cellId: string, expiry: CellDeadlineExpiry) => void;
}

export function createManagedCell(init: ManagedCellInit): ManagedCell {
	// An explicit longer per-call timeout raises the deadline, mirroring bash keeping explicit timeouts.
	const hardLimitSeconds = Math.max(init.defaultHardLimitSeconds, init.input.timeout ?? 0);
	const runBudgetSeconds = init.input.timeout ?? init.defaultRunBudgetSeconds;
	return {
		cellId: init.cellId,
		input: init.input,
		spillPath: detachedNotificationSpillPath(init.artifactsDir, init.cellId),
		startedAtMs: init.now(),
		state: "running",
		canDetach: false,
		wasDetached: false,
		kernel: undefined,
		stateRetained: undefined,
		interruptNote: undefined,
		interruptOutcome: undefined,
		liveResult: undefined,
		terminalResult: undefined,
		notificationQueued: false,
		deadlines: new CellDeadlines({
			cellId: init.cellId,
			hardLimitSeconds,
			runBudgetSeconds,
			onExpire: (expiry) => init.onExpire(init.cellId, expiry),
		}),
		hardLimitSeconds,
		runBudgetSeconds,
		hardLimited: false,
		runBudgetExhausted: false,
		onKill: init.onKill,
		terminal: Promise.withResolvers<EvalDetachedCellSnapshot>(),
	};
}
