/**
 * Internal plumbing, not extension API (#6770): on a hand, `ctx.isIdle()` of the context of a call that ended the
 * loop's turn (`agent_end`) keeps tracking whether the loop session is still idle after that turn only for work that
 * holds it. The hooks builtin's Stop, held for background work, holds it until it settles, and the hand forgets the
 * session's turn state once nothing holds it. The runner registers the hold for each loop-hook call's context; a local
 * session's contexts have none. It is keyed by the context object, so nothing on the context carries it.
 */
const holds = new WeakMap<object, () => () => void>();

/** Gives `context`, a loop-hook call's context, that call's idle hold. */
export function bindIdleHold(context: object, hold: () => () => void): void {
	holds.set(context, hold);
}

/** Holds the idle tracking of `context`'s call until the returned release runs; `undefined` where there is none. */
export function holdIdle(context: object): (() => void) | undefined {
	return holds.get(context)?.();
}
