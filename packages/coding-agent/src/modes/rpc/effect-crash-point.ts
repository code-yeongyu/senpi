/**
 * Test-only crash point for the effect ledger's durability tests: with
 * `SENPI_TEST_RPC_EFFECT_CRASH=<before|after>:<kind>:<state>` the host SIGKILLs itself right before or
 * right after it appends that `rpc_effect` entry, which is the only way to prove the reopen seal from a
 * real transcript left by a dead process. Unset in every production launch, so this is a no-op there.
 */
export const EFFECT_CRASH_ENV = "SENPI_TEST_RPC_EFFECT_CRASH";

export function effectCrashPoint(phase: "before" | "after", kind: string, state: string): void {
	if (process.env[EFFECT_CRASH_ENV] === `${phase}:${kind}:${state}`) process.kill(process.pid, "SIGKILL");
}
