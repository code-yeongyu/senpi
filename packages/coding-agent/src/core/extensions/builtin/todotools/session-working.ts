import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { connectSessionLiveness, type SessionLiveness } from "../session-liveness/connect.ts";

const LOOP = { runs: "brain" } as const;

/**
 * Whether the session is working, read from the session's one liveness watcher (senpi#1146). `onChange` runs when
 * that answer flips. Only a session that can show the widget (`ctx.hasUI`: the TUI, an RPC host) consumes it, so a
 * print or json run never starts the watcher's child-record reads. With no watcher bound every item draws as before.
 */
export function watchSessionWorking(
	pi: Pick<ExtensionAPI, "on" | "events">,
	onChange: (ctx: ExtensionContext) => void,
): () => boolean {
	let liveness: SessionLiveness | undefined;
	let unsubscribe: (() => void) | undefined;
	let drawn = true;
	const isWorking = (): boolean => liveness?.working() ?? true;

	pi.on(
		"session_start",
		(_event, ctx) => {
			unsubscribe?.();
			unsubscribe = undefined;
			liveness = ctx.hasUI ? connectSessionLiveness(pi.events) : undefined;
			unsubscribe = liveness?.subscribe(() => {
				if (isWorking() === drawn) return;
				drawn = isWorking();
				onChange(ctx);
			});
			drawn = isWorking();
		},
		LOOP,
	);
	pi.on(
		"session_shutdown",
		() => {
			unsubscribe?.();
			unsubscribe = undefined;
			liveness = undefined;
		},
		LOOP,
	);
	return isWorking;
}
