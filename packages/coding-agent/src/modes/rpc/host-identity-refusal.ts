import { RpcEndpointAuthError, type RpcEndpointAuthErrorCode } from "./rpc-auth-proof.ts";

/** A host that answered but could not be proven: the refusal an API that answers typed refusals returns (omo#15197). */
export interface HostIdentityRefusal {
	readonly refused: RpcEndpointAuthErrorCode;
	readonly detail: string;
}

/** Runs a probe and returns its identity refusal as a value; every other failure still throws. */
export async function probeOrIdentityRefusal<T>(probe: () => Promise<T>): Promise<T | HostIdentityRefusal> {
	try {
		return await probe();
	} catch (error) {
		if (error instanceof RpcEndpointAuthError) return { refused: error.code, detail: error.message };
		throw error;
	}
}

export function isIdentityRefusal(value: unknown): value is HostIdentityRefusal {
	return typeof value === "object" && value !== null && "refused" in value && "detail" in value;
}
