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
 * Must equal `Object.values(LOCATOR_FLAGS)` in `./host-lifecycle-launch.ts`; duplicated like the sentinel above so the
 * ordinary CLI path never imports that module. `test/suite/regressions/1781-main-lazy-modes.test.ts` asserts equality.
 */
export const RESERVATION_LOCATOR_ROUTE_FLAGS: readonly string[] = [
	"--reservation-store",
	"--reservation-endpoint",
	"--reservation-generation",
	"--reservation-role",
];

/** A reserved host's admission: the argv with its locator consumed, and the pre-listen intent it commits before binding. */
export interface ReservedHostAdmission {
	readonly args: string[];
	/**
	 * Design 4.2a step 4: the short transaction that revalidates this host's grant and records its intent, run by the
	 * socket host immediately before its bind. Absent for a direct launch.
	 */
	readonly beforeListen?: () => Promise<void>;
}

/**
 * Reservation-only host entry (#4199): consume the private locator before the public CLI parser and before any listener.
 * Only the exact locator flags select this path; an unrelated argument that merely shares their prefix is left to the
 * public parser. Like the supervisor route above, the ordinary CLI path loads none of the reservation/SQLite graph.
 */
export async function admitReservedHostArgs(args: string[]): Promise<ReservedHostAdmission> {
	if (!args.some((arg) => RESERVATION_LOCATOR_ROUTE_FLAGS.includes(arg))) return { args };
	const {
		admitClaimedParticipant,
		commitListenIntent,
		IDENTITY_OBSERVATION_PROBE_MS,
		LaunchReservationError,
		parseReservationLocatorArgs,
		readClaimantIdentity,
	} = await import("./host-launch-reservation.ts");
	const { HOST_STARTUP_BUDGET_MS, LOCATOR_FLAGS } = await import("./host-lifecycle-launch.ts");
	const { readProcessStartTime } = await import("../../utils/process-identity.ts");
	const { readSocketSecret, socketSecretPath } = await import("./socket-transport.ts");
	const locator = parseReservationLocatorArgs(args);
	if (!locator || locator.role !== "host") {
		throw new LaunchReservationError("locator_incomplete", "the host entry requires a host reservation");
	}
	// The grant wait shares the supervisor's startup budget for this host, its own identity read included.
	const until = Date.now() + HOST_STARTUP_BUDGET_MS;
	const self = await readClaimantIdentity(
		process.pid,
		(pid) => readProcessStartTime(pid, process.platform, IDENTITY_OBSERVATION_PROBE_MS),
		HOST_STARTUP_BUDGET_MS,
	);
	const credential = await readSocketSecret(socketSecretPath(locator.endpoint)).catch(() => undefined);
	await admitClaimedParticipant(locator, self, credential, { deadlineMs: Math.max(0, until - Date.now()) });
	const flags = new Set<string>(Object.values(LOCATOR_FLAGS));
	const remaining: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (flags.has(args[index])) index++;
		else remaining.push(args[index]);
	}
	return {
		args: remaining,
		beforeListen: async () => {
			if (!credential) throw new LaunchReservationError("commitment_mismatch", "no established public secret");
			await commitListenIntent(locator, self, credential);
		},
	};
}
