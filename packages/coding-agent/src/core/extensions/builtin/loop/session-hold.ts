import type { ExtensionContext } from "../../types.ts";

export function sessionHeld(ctx: ExtensionContext): boolean {
	return ctx.getPauseState?.().holds.some((hold) => hold.kind !== "run_fence") === true;
}

export function userStopped(ctx: ExtensionContext): boolean {
	return (
		ctx.getPauseState?.().holds.some((hold) => hold.kind === "session_hold" && hold.key !== "interrupted-run") ===
		true
	);
}
