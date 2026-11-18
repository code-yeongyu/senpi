import type { SessionSpawnAttestation } from "@code-yeongyu/senpi";

/**
 * Attests a process this host spawned for a kernel to the session it runs for (senpi#6972): a kernel process, so every
 * descendant (a `Bun.$` command, a python subprocess) resolves to that session, or a child the worker kernel reported.
 *
 * The extension injects it, bound to the session's own id, as it injects `collectOrphanedChildren`: a kernel module
 * never loads the host runtime itself, so it stays loadable on its own (plain Node ESM, a compiled python host).
 * Absent, nothing is recorded.
 */
export type AttestKernelSpawn = (pid: number) => SessionSpawnAttestation;

/** Attests a spawned kernel child through `attest` and releases the record when the child exits. */
export function attestKernelChild(
	attest: AttestKernelSpawn | undefined,
	child: { readonly pid?: number; once(event: "exit", listener: () => void): unknown },
): void {
	if (attest === undefined || child.pid === undefined) return;
	const attestation = attest(child.pid);
	child.once("exit", () => void attestation.release());
}
