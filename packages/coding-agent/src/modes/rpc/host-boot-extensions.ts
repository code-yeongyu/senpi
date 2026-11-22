/**
 * A multi-session host loads its extensions per `open_session` or `warm`. A launch that hands it a
 * private descriptor table expects an extension to claim its channel with no session open (the omo
 * desktop waits for that channel's first frame before it opens one), so such a host runs the warm of
 * its default profile once at boot (senpi#6147). It is that exact warm: a client's `warm` of the same
 * profile joins it or answers `already_warm`, so the factories never run twice for it. Without a table nothing changes.
 */
import { privateTablePresent } from "../../private-fds.ts";
import type { HostWarm, HostWarmProfile } from "./host-warm.ts";

/** Starts the boot load and returns at once: it never delays the listener, and a failure is only logged. */
export function warmAtBootForPrivateFds(
	warm: HostWarm | undefined,
	profile: HostWarmProfile,
	log: (message: string) => void,
): void {
	if (warm === undefined || !privateTablePresent()) return;
	warm(profile).catch((cause: unknown) => {
		log(`boot extension load failed: ${cause instanceof Error ? cause.message : String(cause)}`);
	});
}
