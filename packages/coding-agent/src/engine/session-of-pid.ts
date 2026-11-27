import { type PidSession, resolvePidSession } from "../core/session-spawn-attestation.ts";
import { type EngineResult, engineError, engineOk } from "./result.ts";

export interface SessionOfPidInput {
	readonly pid: number;
}

/** Which session spawned `pid`, from the kernel's ancestry and this engine's spawn records; never an environment. */
export async function sessionOfPid(input: SessionOfPidInput): Promise<EngineResult<PidSession, "invalid_input">> {
	if (!Number.isInteger(input.pid) || input.pid <= 0)
		return engineError("invalid_input", "pid must be a positive integer");
	return engineOk(await resolvePidSession(input.pid));
}
