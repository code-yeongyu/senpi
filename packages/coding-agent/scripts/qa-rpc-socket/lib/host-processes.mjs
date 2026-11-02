/**
 * Reaping a host this run started, for the case where the polite stop could not end it.
 * Kept out of the QA script so any other live-QA entry point can leave the machine clean the
 * same way instead of re-implementing the escalation.
 */
/** Bounded pause between liveness polls; a pid we do not own has no exit event to subscribe to. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function reap(pid) {
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		if (!alive(pid)) break;
		try {
			process.kill(pid, signal);
		} catch {}
		await awaitPidGone(pid, 10_000);
	}
	return { pid, alive: alive(pid) };
}

export async function awaitPidGone(pid, budgetMs = 60_000) {
	const deadline = Date.now() + budgetMs;
	while (Date.now() <= deadline) {
		if (!alive(pid)) return true;
		await delay(100);
	}
	return false;
}

export function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
