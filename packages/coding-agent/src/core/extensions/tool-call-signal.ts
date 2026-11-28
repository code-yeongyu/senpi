/**
 * A nested call's hooks and permission prompt observe both the call and turn signals. Either can end
 * their wait without aborting the other controller. The tool run follows only the call's own signal,
 * so a detached caller's work can survive a later turn's abort (senpi#6679).
 */
export function combinedToolCallSignal(
	callSignal: AbortSignal | undefined,
	turnSignal: AbortSignal | undefined,
): AbortSignal | undefined {
	if (callSignal === undefined) return turnSignal;
	if (turnSignal === undefined || turnSignal === callSignal) return callSignal;
	return AbortSignal.any([callSignal, turnSignal]);
}
