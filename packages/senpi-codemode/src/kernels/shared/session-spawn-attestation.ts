import { attestSessionSpawn, type SessionSpawnAttestation } from "@code-yeongyu/senpi";
import type { SessionEnvironment } from "../session-env.ts";

/**
 * Attests a process this host spawned for a kernel to the session it runs for (senpi#6972): a kernel process, so every
 * descendant (a `Bun.$` command, a python subprocess) resolves to that session, or a child the worker kernel reported.
 * The session id is the host's own `sessionEnv`, never anything the kernel can set. No session, no record.
 */
export function attestKernelSpawn(
	sessionEnv: SessionEnvironment | undefined,
	pid: number | undefined,
): SessionSpawnAttestation | undefined {
	const sessionId = sessionEnv?.PI_SESSION_ID;
	if (sessionId === undefined || pid === undefined) return undefined;
	return attestSessionSpawn(sessionId, pid);
}

/** {@link attestKernelSpawn} for a spawned child, released when it exits. */
export function attestKernelChild(
	sessionEnv: SessionEnvironment | undefined,
	child: { readonly pid?: number; once(event: "exit", listener: () => void): unknown },
): void {
	const attestation = attestKernelSpawn(sessionEnv, child.pid);
	if (attestation !== undefined) child.once("exit", () => void attestation.release());
}
