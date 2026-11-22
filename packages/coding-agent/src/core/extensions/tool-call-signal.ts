/**
 * The signal a nested call's hooks and tool run serve: the call's own signal combined with the turn's
 * (senpi#6679 M1), so aborting either ends the call — and its permission prompt. A call signal not linked to
 * the turn must not replace the turn's (the prompt would survive a whole-turn abort); the turn's must not
 * silence the call's own (#6676). The union never aborts either original controller.
 */
export function combinedToolCallSignal(
	callSignal: AbortSignal | undefined,
	turnSignal: AbortSignal | undefined,
): AbortSignal | undefined {
	if (callSignal === undefined) return turnSignal;
	if (turnSignal === undefined || turnSignal === callSignal) return callSignal;
	return AbortSignal.any([callSignal, turnSignal]);
}
