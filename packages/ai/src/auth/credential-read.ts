import { ConfigReferenceError } from "../utils/config-reference-error.ts";
import { ModelsError } from "../utils/models-error.ts";
import { projectSlot } from "./pool/slots.ts";
import type { Credential, CredentialStore } from "./types.ts";

export async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}

/** A key still holding an object was never resolved by its declaring store, so it never reaches a provider. */
export async function readSlotCredential(
	credentials: CredentialStore,
	providerId: string,
	slotName: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	let projected: Credential | undefined;
	try {
		projected = credentials.readSlot
			? await credentials.readSlot(providerId, slotName, { signal })
			: projectSlot(await credentials.read(providerId, { signal }), slotName);
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
	const key: unknown = projected?.type === "api_key" ? projected.key : undefined;
	if (typeof key === "object" && key !== null) {
		const cause = new ConfigReferenceError(`${providerId}.accounts.${slotName}.key`, key, "forbidden");
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause });
	}
	return projected;
}
