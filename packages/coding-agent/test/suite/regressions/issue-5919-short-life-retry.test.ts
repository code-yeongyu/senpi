import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	accountHost,
	claimsOf,
	closeAccountHosts,
	enrollAssignAcquire,
	installation,
	issuer,
} from "../../mcp/fixtures/presenter-account-host.ts";
import { secretHostIssuer } from "../../mcp/fixtures/secret-host-issuer.ts";

// D11 secret phase S5-1 (senpi#4249): the short-life retry branch of the host token cache (senpi#5919).
// Only the host's timers are faked, so the refresh is driven explicitly; sockets, the issuer's ES256
// and the host key's Ed25519 stay real.
const SECRET = ["secret_input_v1"];
const nowS = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
	await closeAccountHosts();
	vi.useRealTimers();
});

async function secretHost(lifetimeS?: number) {
	const secret = secretHostIssuer(issuer, lifetimeS);
	const host = await accountHost({ account: secret.authority });
	return { host, secret };
}

it("a failed re-mint with a short-lived token retries before the token expires (senpi#5919)", async () => {
	// A 4 s token is re-minted at two thirds of its lifetime, when ~3-4 s remain. The old code armed
	// the retry at the 5 s floor, landing ~1 s after the token's exp; the retry must land before exp.
	const { host, secret } = await secretHost(4);
	await enrollAssignAcquire(host, installation(), { features: SECRET, claims: { exp: nowS() + 900 } });
	await secret.mints[0]?.done;
	const first = host.control.sealed?.tokens.current("durable");
	expect(first).toBeDefined();

	secret.plan({ fail: true });
	// The re-mint is armed at two thirds of the 4 s lifetime (2.0-2.7 s; the exact ms depends on
	// the sub-second fraction of the mint time), so 2 s is provably too early and 2.7 s is enough.
	vi.advanceTimersByTime(2_000);
	expect(secret.mints).toHaveLength(1);
	vi.advanceTimersByTime(700);
	expect(secret.mints).toHaveLength(2);
	await secret.mints[1]?.done;
	expect(host.control.sealed?.tokens.current("durable")).toEqual(first);

	// Within the remaining ~3 s the retry must already have fired; the 5 s floor would still wait.
	vi.advanceTimersByTime(3_000);
	expect(secret.mints).toHaveLength(3);
	await secret.mints[2]?.done;
	expect(claimsOf(host.control.sealed?.tokens.current("durable")?.token ?? "")).toEqual(secret.mints[2]?.claims);
});
