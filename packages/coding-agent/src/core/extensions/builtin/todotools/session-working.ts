import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { connectSessionLiveness, type SessionLiveness } from "../session-liveness/connect.ts";

const LOOP = { runs: "brain" } as const;

/**
 * Whether the session is working, read from the session's one liveness watcher (senpi#1146). `onChange` runs when
 * that answer flips. With no watcher bound (the session-liveness builtin is not loaded) every item draws as before.
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
			liveness = connectSessionLiveness(pi.events);
			drawn = isWorking();
			unsubscribe = liveness?.subscribe(() => {
				if (isWorking() === drawn) return;
				drawn = isWorking();
				onChange(ctx);
			});
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
