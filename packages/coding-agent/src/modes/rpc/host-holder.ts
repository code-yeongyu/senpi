/**
 * WHO holds an endpoint an ensure refused to touch (omo-desktop-app#3561).
 *
 * A `foreign_writer` refusal is final by I1: the registered generation was written by another process,
 * it still accepts at the public path, and it did not answer as a host. The refusal used to carry only
 * its reason, so every client - TUI, CLI, desktop - could say that something was in the way but not
 * what. The generation's own record already names it; this is that record as the refusal reports it.
 *
 * A leaf on purpose: `host-decision.ts` words refusals with it and sits in the supervisor's import graph.
 */

/** The generation a refusal left standing, as its registration records it. */
export interface HostHolder {
	/** The process serving the endpoint (the generation's supervisor). */
	readonly pid: number;
	readonly instanceId: string;
	readonly generation: number;
	readonly processStartTime: string | null;
	/** The engine build the generation recorded at start; `null` for a record that predates the field. */
	readonly engineVersion: string | null;
	/** The launch profile the generation was started with; `null` when it recorded none. */
	readonly launchProfileId: string | null;
	/** The process that registered the generation (the client whose ensure started it). */
	readonly writerPid: number | null;
}

/** The holder in one clause: `pid 4242, engine 2026.10.16, launch profile cli-profile`. */
export function describeHostHolder(holder: HostHolder): string {
	const engine = holder.engineVersion === null ? "an unrecorded engine" : `engine ${holder.engineVersion}`;
	const profile = holder.launchProfileId === null ? "" : `, launch profile ${holder.launchProfileId}`;
	const writer =
		holder.writerPid === null || holder.writerPid === holder.pid ? "" : `, started by pid ${holder.writerPid}`;
	return `pid ${holder.pid}, ${engine}${profile}${writer}`;
}
