import type { AccountPrincipal, PresenterAccountRefusal } from "./mcp-presenter-account.ts";

/**
 * Why an account principal is no longer current (D11 S3-4), or `undefined` while it is: the host must still be signed
 * into the attested account, and the attestation must not have reached `attestedUntil`.
 */
export function accountLapse(
	principal: Pick<AccountPrincipal, "acc" | "attestedUntil">,
	hostAccount: string | undefined,
	nowS: number,
): PresenterAccountRefusal | undefined {
	if (hostAccount === undefined) return "presenter_account_unavailable";
	if (hostAccount !== principal.acc) return "presenter_account_mismatch";
	return nowS < principal.attestedUntil ? undefined : "attestation_expired";
}

/** One timer per account principal that revokes it at `attestedUntil`; each re-attestation re-arms it. */
export class AttestationExpiry {
	private readonly timers = new Map<AccountPrincipal, NodeJS.Timeout>();

	arm(principal: AccountPrincipal, expire: () => void): void {
		this.clear(principal);
		const delay = Math.max(0, principal.attestedUntil * 1000 - Date.now());
		const timer = setTimeout(expire, delay);
		// The host's own lifetime decides when it exits; a pending expiry never holds the process.
		timer.unref();
		this.timers.set(principal, timer);
	}

	clear(principal: AccountPrincipal): void {
		clearTimeout(this.timers.get(principal));
		this.timers.delete(principal);
	}

	dispose(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
}
