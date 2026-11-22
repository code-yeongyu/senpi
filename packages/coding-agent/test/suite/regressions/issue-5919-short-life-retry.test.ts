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
	// The clock is faked and pinned to a whole second: the issuer stamps `iat` from `Date.now()`, so an
	// unfaked clock lets a mint land late in a second and drops the armed refresh just under its bound.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
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
	// The re-mint is armed at two thirds of the 4 s lifetime (2666 ms with the clock pinned to a whole
	// second), so 2 s is provably too early and 2.7 s is enough.
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

it("continued mint failures in the last second before exp stay spaced and bounded (senpi#5919)", async () => {
	// A 3 s token whose every re-mint fails: the pre-fix code armed each retry at 0 ms once under 1 s
	// remained, hammering the failing issuer back-to-back until `exp` (678 calls in the probe). With the
	// minimum wait, retries stay at least 250 ms apart and stop once the token expires.
	const { host, secret } = await secretHost(3);
	await enrollAssignAcquire(host, installation(), { features: SECRET, claims: { exp: nowS() + 900 } });
	await secret.mints[0]?.done;
	const first = host.control.sealed?.tokens.current("durable");
	expect(first).toBeDefined();

	for (let i = 0; i < 10; i++) secret.plan({ fail: true });
	// The re-mint is armed at two thirds of the 3 s lifetime (2000 ms with the clock pinned).
	vi.advanceTimersByTime(2_000);
	expect(secret.mints).toHaveLength(2);
	await secret.mints[1]?.done;

	// Under 250 ms after the failure, no retry may have fired.
	vi.advanceTimersByTime(200);
	expect(secret.mints).toHaveLength(2);
	// Step through the last second in 250 ms slices: each slice fires at most one retry, for 4 retries
	// total (at 2250/2500/2750/3000 ms), then the token expires and the retry falls back to the 60 s bound.
	for (let n = 3; n <= 6; n++) {
		vi.advanceTimersByTime(250);
		expect(secret.mints).toHaveLength(n);
		await secret.mints[n - 1]?.done;
	}
	vi.advanceTimersByTime(5_000);
	expect(secret.mints).toHaveLength(6);
	expect(host.control.sealed?.tokens.current("durable")).toBeUndefined();
});
