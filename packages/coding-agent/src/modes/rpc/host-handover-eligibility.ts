/**
 * Whether a handover may publish a successor while this generation still serves (code-yeongyu/oh-my-openagent#10091).
 *
 * A handover OVERLAPS when this generation still holds a session, or an application connection a fresh open could
 * reuse. An overlapping update needs the endpoint's opt-in and, on every application connection, both client
 * declarations: new sessions go to the current generation (`generation_separated_admission_v1`) and a parked session
 * is reconciled on its own (`session_transfer_reconciliation_v1`). Explicit observers never count. A host holding
 * nothing overlaps nothing and may publish without either, which is what the idle handover did on an idle host.
 * The host running this transfers sessions strictly by construction; a CLI never asks a host that does not.
 */
import type { DeferredReason } from "./host-handover-operation.ts";

export const GENERATION_SEPARATED_ADMISSION_CAPABILITY = "generation_separated_admission_v1";
export const SESSION_TRANSFER_RECONCILIATION_CAPABILITY = "session_transfer_reconciliation_v1";

export interface HandoverClientView {
	readonly sessions: number;
	readonly capableClients: number;
	readonly legacyClients: number;
}

export type HandoverEligibility =
	| { readonly kind: "eligible"; readonly overlap: boolean }
	| { readonly kind: "deferred"; readonly reason: DeferredReason };

export function judgeHandoverEligibility(clients: HandoverClientView, overlapEnabled: boolean): HandoverEligibility {
	const overlap = clients.sessions > 0 || clients.capableClients + clients.legacyClients > 0;
	if (!overlap) return { kind: "eligible", overlap: false };
	if (!overlapEnabled) return { kind: "deferred", reason: "rollout_disabled" };
	if (clients.legacyClients > 0) return { kind: "deferred", reason: "legacy_attached_client" };
	return { kind: "eligible", overlap: true };
}

export function declaresOverlapCapabilities(capabilities: readonly string[] | undefined): boolean {
	return (
		capabilities?.includes(GENERATION_SEPARATED_ADMISSION_CAPABILITY) === true &&
		capabilities.includes(SESSION_TRANSFER_RECONCILIATION_CAPABILITY)
	);
}
