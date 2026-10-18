/** Thrown by the runner and loader guards when a retired extension generation touches its old ctx or API. */
export class StaleExtensionContextError extends Error {
	override readonly name = "StaleExtensionContextError";
}
