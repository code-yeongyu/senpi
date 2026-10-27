/**
 * Internal RPC host supervisor route, kept out of the startup import graph.
 *
 * `main()` has to answer "is this process an internal host supervisor?" before anything else runs,
 * and the answer is almost always no: the route is an internal launch surface used by
 * `ensureHost()` and by rebranded wrappers, never by a human CLI run. Asking through a static
 * import of `./host-lifecycle.ts` pulled the RPC host graph - multi-session host, socket
 * transport/ownership, the shared process helpers - into every launch, so the sentinel
 * scan lives here and the supervisor module is imported only once argv carries the sentinel.
 *
 * The sentinel literal is duplicated from `INTERNAL_SUPERVISOR_FLAG` on purpose: importing that
 * constant would import the module this route exists to defer.
 * `test/suite/regressions/1781-main-lazy-modes.test.ts` asserts the two stay equal.
 */

/** Must equal `INTERNAL_SUPERVISOR_FLAG` in `./host-lifecycle.ts`. */
export const INTERNAL_SUPERVISOR_ROUTE_FLAG = "--internal-rpc-host-supervisor";

/**
 * Runs the internal supervisor when argv selects that route, and reports whether it did.
 *
 * The strict argv shape - the sentinel at argv[0], or preceded only by injectable prefix flags a
 * rebranded wrapper may legitimately have added - stays owned by `findInternalSupervisorArgs()`.
 * The scan here is a deliberate superset of it: argv that merely mentions the sentinel pays for the
 * import and then falls through to the public parser exactly as before, so a user-supplied value
 * equal to the sentinel still cannot reach the supervisor.
 */
export async function dispatchInternalSupervisor(args: readonly string[]): Promise<boolean> {
	if (!args.includes(INTERNAL_SUPERVISOR_ROUTE_FLAG)) return false;
	const { findInternalSupervisorArgs, parseSupervisorArgs, runHostSupervisor } = await import("./host-lifecycle.ts");
	const supervisorArgs = findInternalSupervisorArgs(args);
	if (!supervisorArgs) return false;
	const launch = parseSupervisorArgs(supervisorArgs);
	if (!launch) {
		// Fail closed: an internal protocol fault must never fall through to the
		// public parser and surface as a confusing "Unknown option" error.
		console.error("invalid internal RPC host supervisor arguments");
		process.exit(2);
	}
	await runHostSupervisor(launch);
	return true;
}

/**
 * Reservation-only host entry (#4199): consume the private locator before the public CLI parser and before any listener.
 * Like the supervisor route above, the ordinary CLI path loads none of the reservation/SQLite graph.
 */
export async function admitReservedHostArgs(args: string[]): Promise<string[]> {
	if (!args.some((arg) => arg.startsWith("--reservation-"))) return args;
	const { admitClaimedParticipant, parseReservationLocatorArgs, LaunchReservationError } =
		await import("./host-launch-reservation.ts");
	const { LOCATOR_FLAGS } = await import("./host-lifecycle-launch.ts");
	const { readProcessStartTime } = await import("../../utils/process-identity.ts");
	const { readSocketSecret, socketSecretPath } = await import("./socket-transport.ts");
	const locator = parseReservationLocatorArgs(args);
	if (!locator || locator.role !== "host") {
		throw new LaunchReservationError("locator_incomplete", "the host entry requires a host reservation");
	}
	const self = { pid: process.pid, processStartTime: (await readProcessStartTime(process.pid)) ?? null };
	const credential = await readSocketSecret(socketSecretPath(locator.endpoint)).catch(() => undefined);
	// The host holds its presence lock from before its claim for the life of this process: its shutdown does not yet
	// prove quiescence, so it commits no `released` and the kernel releases the guard when the process exits.
	await admitClaimedParticipant(locator, self, credential, { deadlineMs: 10_000 });
	const flags = new Set<string>(Object.values(LOCATOR_FLAGS));
	const remaining: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (flags.has(args[index])) index++;
		else remaining.push(args[index]);
	}
	return remaining;
}
