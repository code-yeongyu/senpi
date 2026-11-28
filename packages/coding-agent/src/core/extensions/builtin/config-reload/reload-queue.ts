import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";
import type { WatchClock } from "./watch-engine.ts";

/**
 * How long one session's watcher-triggered reload holds the process-wide slot. No existing limit bounds a whole
 * reload: its `session_start` handlers run without the agent-lifecycle handler cap. A reload past this bound keeps
 * running on its own while the next session takes the slot.
 */
export const RELOAD_SLOT_TIMEOUT_MS = 60_000;

interface ReloadScheduler {
	schedule(work: () => Promise<void>): Promise<void> | undefined;
}

// Every engine copy serving sessions on this event loop shares one queue, so one change reloads one session at a time.
const processReloadScheduler = realmRegistry(
	"@code-yeongyu/senpi/config-reload-scheduler/v1",
	(): ReloadScheduler => {
		let tail: Promise<void> | undefined;
		return {
			schedule(work) {
				const previous = tail;
				const next = (previous ?? Promise.resolve()).then(work);
				const release = () => {
					if (tail === settled) tail = undefined;
				};
				const settled = next.then(release, release);
				tail = settled;
				return previous ? undefined : next;
			},
		};
	},
	(value): value is ReloadScheduler => hasFunctions(value, ["schedule"]),
);

/**
 * Queue one session's reload behind every other session's. Returns the slot when the reload starts at once and
 * `undefined` when it waits: a `session_start` handler inside a running reload must not wait on that reload.
 * The slot is released when the reload settles or after `RELOAD_SLOT_TIMEOUT_MS`, whichever comes first;
 * `onOverrun` reports a reload that outlived the bound, once.
 */
export function queueReload(
	reload: () => Promise<void>,
	clock: WatchClock,
	onOverrun: () => void,
): Promise<void> | undefined {
	return processReloadScheduler.schedule(
		() =>
			new Promise<void>((release) => {
				const timer = clock.setTimeout(() => {
					onOverrun();
					release();
				}, RELOAD_SLOT_TIMEOUT_MS);
				const settle = () => {
					clock.clearTimeout(timer);
					release();
				};
				reload().then(settle, settle);
			}),
	);
}
