// Additive hooks are intentionally registered by name: the baseline predates their TS overloads.
// The observer never changes tools, messages, lifecycle state, or callback results.
interface ObserverApi {
	on(type: string, handler: (event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => void): void;
}
export default function observer(pi: ObserverApi): void {
	const state = (
		globalThis as typeof globalThis & {
			__parkedSessionQa?: { record(type: string, sessionId: string): void };
		}
	).__parkedSessionQa;
	if (!state) throw new Error("parked-session QA requires the observer preload in the host process");
	for (const type of ["session_start", "session_parked", "session_resumed"]) {
		pi.on(type, (_event, ctx) => state.record(type, ctx.sessionManager.getSessionId()));
	}
}
