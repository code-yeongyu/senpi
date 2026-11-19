/**
 * Asking the predecessor of a handoff to drain, once the successor owns the socket (`host-successor.ts`).
 *
 * A predecessor that admitted the handoff (senpi#7044) is shown its admission over the connection it was granted on,
 * and is never signalled: it ignores a bare SIGUSR1. One from before the admission gets the signal, sent to the pid
 * its record proved and only because it advertised that it survives it.
 */
import type { HandoffAdmission } from "./host-handoff-admission-request.ts";
import { signalGeneration } from "./host-stop.ts";

/** How long the predecessor is given to confirm the drain it admitted; it drains on losing the socket either way. */
const ADMITTED_DRAIN_TIMEOUT_MS = 10_000;

export async function requestPredecessorDrain(
	pid: number,
	admission: HandoffAdmission | undefined,
	socket: string,
): Promise<void> {
	if (admission === undefined) {
		signalGeneration(pid, "SIGUSR1");
		return;
	}
	// A predecessor whose connection ended is leaving already: it noticed on its own that it lost the public socket,
	// which is the same outcome as a signal that found its process gone.
	if ((await admission.drain(ADMITTED_DRAIN_TIMEOUT_MS)) !== "unconfirmed") return;
	process.stderr.write(
		`generation handoff: the host replaced on ${socket} (pid ${pid}) did not confirm the drain it admitted; it drains itself on losing the public socket\n`,
	);
}
