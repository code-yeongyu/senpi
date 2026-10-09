/**
 * Internal RPC host supervisor route, kept out of the startup import graph.
 *
 * `main()` has to answer "is this process an internal host supervisor?" before anything else runs,
 * and the answer is almost always no: the route is an internal launch surface used by
 * `ensureHost()` and by rebranded wrappers, never by a human CLI run. Asking through a static
 * import of `./host-lifecycle.ts` pulled the RPC host graph - multi-session host, socket
 * transport/ownership, the app-server daemon process helpers - into every launch, so the sentinel
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
