import type { Credential } from "@earendil-works/pi-ai";
import { type CredentialSlot, listSlots, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { writeHealthUnlessStoreBusy } from "./health-write.ts";
import { CredentialSlotRepository } from "./state-store.ts";

/**
 * The stored slots a login started: every slot it created and every slot whose material it replaced. Pool health
 * is keyed to the account, so a token refresh keeps a block (senpi#4093). A login is different: it is the user's own
 * step to repair an account, or it puts another account under a slot name a removed or signed-out one used (an opaque
 * token's account key is its slot name). Neither may inherit the verdicts recorded before it.
 */
export function slotsStartedByLogin(before: Credential | undefined, after: Credential | undefined): string[] {
	const previous = new Map(listSlots(before as PooledCredential | undefined).map((slot) => [slot.name, slot]));
	return listSlots(after as PooledCredential | undefined)
		.filter((slot) => {
			const old = previous.get(slot.name);
			return old === undefined || !sameMaterial(old, slot);
		})
		.map((slot) => slot.name);
}

function sameMaterial(a: CredentialSlot, b: CredentialSlot): boolean {
	return a.access === b.access && a.refresh === b.refresh && a.key === b.key;
}

export async function retireLoginSlotHealth(
	statePath: string,
	providerId: string,
	before: Credential | undefined,
	after: Credential | undefined,
): Promise<void> {
	const started = slotsStartedByLogin(before, after);
	if (started.length === 0) return;
	const repository = new CredentialSlotRepository(statePath);
	for (const name of started) {
		await writeHealthUnlessStoreBusy(`login of ${name}`, () =>
			repository.mutateSlotState(providerId, "stored", name, () => undefined),
		);
	}
}
