import type { PreparableRuntimeFactory } from "./host-warm.ts";
/** Only the CLI factory constructs its own internal Agent channel for every session. */
export function completeCompactFactory(
	factory: PreparableRuntimeFactory,
	prepare: NonNullable<PreparableRuntimeFactory["prepare"]>,
): PreparableRuntimeFactory {
	return Object.assign(factory, { prepare, supportsCompact: () => true });
}
