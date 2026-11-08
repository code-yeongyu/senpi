import { describe, expect, it } from "vitest";
import {
	CLAIM_ISSUE_SKEW_MS,
	CLAIM_MAX_LIFETIME_MS,
	type EpochFloor,
	type PlacementClaim,
	placementClaimSigningInput,
	type SignedPlacementClaim,
	verifyPlacementClaim,
} from "../../src/core/egress/placement-claim.ts";
import {
	AT,
	ACCOUNT,
	checked,
	claimFields,
	forgerOf,
	HOUR,
	IAT,
	knownRoster,
	MONO,
	NOW,
	registry,
	signBytes,
	signClaim,
	trusted,
} from "./claim-fixture.ts";

const floorAt =
	(epoch: number): (() => EpochFloor) =>
	() => ({ epoch, placementId: "placement-a" });

describe("verifyPlacementClaim: single failures (custody design 4.6, 15.15, 15.16, C.P1)", () => {
	it("accepts a claim signed by a checked registry entry of the claim's generation", async () => {
		const { reg, trust } = await trusted();
		expect(await verifyPlacementClaim(await signClaim(claimFields(), reg), trust, AT)).toBe("valid");
	});

	it("forged: a claim signed by a key other than the registry key is invalid", async () => {
		const { reg, trust } = await trusted();
		expect(await verifyPlacementClaim(await signClaim(claimFields(), await forgerOf(reg)), trust, AT)).toBe(
			"invalid",
		);
	});

	it("a field changed after signing is invalid (every field is covered)", async () => {
		const { reg, trust } = await trusted();
		const signed = await signClaim(claimFields(), reg);
		const changes: Partial<PlacementClaim>[] = [
			{ placementId: "placement-b" },
			{ epoch: 8 },
			{ expiresAt: NOW + 2 * HOUR },
			{ issuedAt: NOW - 2_000 },
		];
		for (const change of changes) {
			const tampered = { ...signed, claim: { ...signed.claim, ...change } };
			expect(await verifyPlacementClaim(tampered, trust, AT)).toBe("invalid");
		}
	});

	it("cross-account: a claim for another account is invalid even when the registry key signed it", async () => {
		const { reg, trust } = await trusted();
		const signed = await signClaim(claimFields({ accountId: "other-account" }), reg);
		expect(await verifyPlacementClaim(signed, trust, AT)).toBe("invalid");
	});

	it("key substitution: a sig.keyId other than the selected entry's sigKeyId is invalid", async () => {
		const { reg, trust } = await trusted();
		expect(await verifyPlacementClaim(await signClaim(claimFields(), reg, "reg-9"), trust, AT)).toBe("invalid");
	});

	it("cross-domain: a signature over the bare canonical JSON or under another domain tag is invalid", async () => {
		const { reg, trust } = await trusted();
		const claim = claimFields();
		const prefix = new TextEncoder().encode("omo-custody/placement-claim/v1").length + 1;
		const bare = new Uint8Array(placementClaimSigningInput(claim).subarray(prefix));
		const other = new Uint8Array([...new TextEncoder().encode("omo-custody/wraps-document/v4"), 0, ...bare]);
		for (const message of [bare, other]) {
			const signed: SignedPlacementClaim = {
				claim,
				sig: { alg: "ECDSA-P256-SHA256", keyId: "reg-1", sig: await signBytes(message, reg) },
			};
			expect(await verifyPlacementClaim(signed, trust, AT)).toBe("invalid");
		}
	});

	it("unchecked: a registry entry this device never checked makes the claim unknown", async () => {
		const { reg, trust } = await trusted({ records: [] });
		expect(await verifyPlacementClaim(await signClaim(claimFields(), reg), trust, AT)).toBe("unknown");
	});

	it("unknown key: no registry entry of the claim's generation makes the claim unknown", async () => {
		const { reg, trust } = await trusted();
		const signed = await signClaim(claimFields({ registryGeneration: 2 }), reg);
		expect(await verifyPlacementClaim(signed, trust, AT)).toBe("unknown");
	});

	it("a roster view past its lifetime, or never synced, makes the claim unknown", async () => {
		const { reg, trust } = await trusted();
		const signed = await signClaim(claimFields(), reg);
		expect(await verifyPlacementClaim(signed, trust, { now: NOW, nowMono: MONO + 15 * 60_000 })).toBe("unknown");
		expect(await verifyPlacementClaim(signed, { ...trust, roster: { state: "unknown" } }, AT)).toBe("unknown");
	});

	it("superseded: a checked newer registry generation naming this key supersedes the claim's generation", async () => {
		const { reg, trust } = await trusted();
		const next = await registry(2, reg.entry.sigKeyId);
		const superseding = {
			...trust,
			records: await checked(reg.entry, next.entry),
			roster: knownRoster(reg.entry, next.entry),
		};
		expect(await verifyPlacementClaim(await signClaim(claimFields(), reg), superseding, AT)).toBe("superseded");
	});

	it("expired: expiresAt at effectiveNow is expired; one ms later it is valid", async () => {
		const { reg, trust } = await trusted();
		expect(await verifyPlacementClaim(await signClaim(claimFields({ expiresAt: NOW }), reg), trust, AT)).toBe(
			"expired",
		);
		expect(await verifyPlacementClaim(await signClaim(claimFields({ expiresAt: NOW + 1 }), reg), trust, AT)).toBe(
			"valid",
		);
	});

	it("expiry uses effectiveNow = max(now, rosterIssuedAt): a device clock behind the roster cannot revive a claim", async () => {
		const { reg, trust } = await trusted();
		const signed = await signClaim(claimFields({ issuedAt: IAT - 2_000, expiresAt: IAT - 1 }), reg);
		expect(await verifyPlacementClaim(signed, trust, { now: IAT - 10 * 60_000, nowMono: MONO })).toBe("expired");
	});

	it("an epoch below the highest accepted for this account and generation is invalid; equal or higher passes", async () => {
		const { reg, trust } = await trusted({ epochFloor: floorAt(8) });
		const at = (epoch: number) => signClaim(claimFields({ epoch }), reg);
		expect(await verifyPlacementClaim(await at(7), trust, AT)).toBe("invalid");
		expect(await verifyPlacementClaim(await at(8), trust, AT)).toBe("valid");
		expect(await verifyPlacementClaim(await at(9), trust, AT)).toBe("valid");
	});

	it("the accepted epoch held by another placement is invalid", async () => {
		const { reg, trust } = await trusted({ epochFloor: floorAt(7) });
		const signed = await signClaim(claimFields({ placementId: "placement-b" }), reg);
		expect(await verifyPlacementClaim(signed, trust, AT)).toBe("invalid");
	});

	it("reads the epoch floor keyed by the claim's account and registry generation", async () => {
		const asked: [string, number][] = [];
		const { reg, trust } = await trusted({
			epochFloor: (accountId: string, generation: number) => {
				asked.push([accountId, generation]);
				return undefined;
			},
		});
		await verifyPlacementClaim(await signClaim(claimFields(), reg), trust, AT);
		expect(asked).toEqual([[ACCOUNT, 1]]);
	});

	it("claim-lifetime-bounded: a lifetime over 24 h is malformed; exactly 24 h is accepted", async () => {
		const { reg, trust } = await trusted();
		const issuedAt = NOW - 1_000;
		const long = await signClaim(claimFields({ issuedAt, expiresAt: issuedAt + CLAIM_MAX_LIFETIME_MS + 1 }), reg);
		const full = await signClaim(claimFields({ issuedAt, expiresAt: issuedAt + CLAIM_MAX_LIFETIME_MS }), reg);
		expect(CLAIM_MAX_LIFETIME_MS).toBe(24 * HOUR);
		expect(await verifyPlacementClaim(long, trust, AT)).toBe("malformed");
		expect(await verifyPlacementClaim(full, trust, AT)).toBe("valid");
	});

	it("claim-skew-tolerates-device-clock: issuedAt up to 5 min ahead of the device is accepted, beyond is malformed", async () => {
		const { reg, trust } = await trusted();
		const inSkew = await signClaim(claimFields({ issuedAt: NOW + CLAIM_ISSUE_SKEW_MS }), reg);
		const beyond = await signClaim(claimFields({ issuedAt: NOW + CLAIM_ISSUE_SKEW_MS + 1 }), reg);
		expect(CLAIM_ISSUE_SKEW_MS).toBe(5 * 60_000);
		expect(await verifyPlacementClaim(inSkew, trust, AT)).toBe("valid");
		expect(await verifyPlacementClaim(beyond, trust, AT)).toBe("malformed");
	});

	it("sleeper-claim-refused: issuedAt more than 24 h after the roster's issue time is malformed", async () => {
		const { reg, trust } = await trusted();
		const issuedAt = IAT + CLAIM_MAX_LIFETIME_MS + 1;
		const sleeper = await signClaim(claimFields({ issuedAt, expiresAt: issuedAt + HOUR }), reg);
		const longRoster = { ...knownRoster(reg.entry), rosterExpiresAt: IAT + 2 * CLAIM_MAX_LIFETIME_MS };
		expect(
			await verifyPlacementClaim(sleeper, { ...trust, roster: longRoster }, { now: issuedAt, nowMono: MONO }),
		).toBe("malformed");
	});
});

describe("verifyPlacementClaim: total order for overlapping failures (custody design C.P1)", () => {
	it("a forged expired claim is invalid, never the retryable expired", async () => {
		const { reg, trust } = await trusted();
		const signed = await signClaim(claimFields({ expiresAt: NOW - 1 }), await forgerOf(reg));
		expect(await verifyPlacementClaim(signed, trust, AT)).toBe("invalid");
	});

	it("a well-signed overlong expired claim is malformed", async () => {
		const { reg, trust } = await trusted();
		const issuedAt = NOW - 2 * CLAIM_MAX_LIFETIME_MS;
		const signed = await signClaim(claimFields({ issuedAt, expiresAt: issuedAt + CLAIM_MAX_LIFETIME_MS + 1 }), reg);
		expect(await verifyPlacementClaim(signed, trust, AT)).toBe("malformed");
	});

	it("a stale roster is unknown even for a forged claim; a bad envelope is malformed even with a stale roster", async () => {
		const { reg, trust } = await trusted({ roster: { state: "unknown" } });
		expect(await verifyPlacementClaim(await signClaim(claimFields(), await forgerOf(reg)), trust, AT)).toBe(
			"unknown",
		);
		expect(await verifyPlacementClaim({ claim: claimFields() }, trust, AT)).toBe("malformed");
	});

	it("a roster past its lifetime makes even a cross-account claim unknown (freshness before account binding)", async () => {
		const { reg, trust } = await trusted();
		const signed = await signClaim(claimFields({ accountId: "other-account" }), reg);
		expect(await verifyPlacementClaim(signed, trust, { now: NOW, nowMono: MONO + 15 * 60_000 })).toBe("unknown");
	});

	it("a lower epoch with an overlong lifetime is invalid (epoch before lifetime bounds)", async () => {
		const { reg, trust } = await trusted({ epochFloor: floorAt(9) });
		const issuedAt = NOW - 1_000;
		const signed = await signClaim(claimFields({ issuedAt, expiresAt: issuedAt + CLAIM_MAX_LIFETIME_MS + 1 }), reg);
		expect(await verifyPlacementClaim(signed, trust, AT)).toBe("invalid");
	});
});
