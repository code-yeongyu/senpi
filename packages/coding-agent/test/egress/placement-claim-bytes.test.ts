import { describe, expect, it } from "vitest";
import {
	CLAIM_VERDICT_ERRORS,
	type PlacementClaim,
	placementClaimSigningInput,
	verifyPlacementClaim,
} from "../../src/core/egress/placement-claim.ts";
import { AT, claimFields, signClaim, trusted } from "./claim-fixture.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
	Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
const DOMAIN = new TextEncoder().encode("omo-custody/placement-claim/v1");

describe("placement-claim signing bytes (custody design C.P1, C.P1.K)", () => {
	it("KAT-C1: the canonical claim bytes and the domain-separated signing input match the pinned vectors", async () => {
		const claim: PlacementClaim = {
			registryGeneration: 3,
			placementId: "p",
			issuedAt: 1000,
			expiresAt: 2000,
			epoch: 2,
			accountId: "a",
		};
		const input = placementClaimSigningInput(claim);
		const canonical = new Uint8Array(input.subarray(DOMAIN.length + 1));
		expect(hex(input.subarray(0, DOMAIN.length))).toBe(hex(DOMAIN));
		expect(input[DOMAIN.length]).toBe(0);
		expect(new TextDecoder().decode(canonical)).toBe(
			'{"accountId":"a","epoch":2,"expiresAt":2000,"issuedAt":1000,"placementId":"p","registryGeneration":3}',
		);
		expect(hex(canonical)).toBe(
			"7b226163636f756e744964223a2261222c2265706f6368223a322c22657870697265734174223a323030302c226973737565644174223a313030302c22706c6163656d656e744964223a2270222c22726567697374727947656e65726174696f6e223a337d",
		);
		expect(await sha256(canonical)).toBe("cde802472ba2ab6410d02f9e3428f12ddbc27077d929e92afe4d812180309950");
		expect(input.length).toBe(132);
		expect(await sha256(input)).toBe("109c0f736055fe532aee688aab968417048e0e3c9db280d7c02ea8a98d067785");
	});

	it("signs only the six claim fields, whatever extra properties the object carries", () => {
		const claim = claimFields();
		const padded: PlacementClaim = Object.assign({ note: "not signed" }, claim);
		expect(hex(placementClaimSigningInput(padded))).toBe(hex(placementClaimSigningInput(claim)));
	});
});

describe("verifyPlacementClaim: closed envelope (custody design C.P1 canonical input)", () => {
	it("refuses every shape outside the closed schema as malformed, before any other check", async () => {
		const { reg, trust } = await trusted({ roster: { state: "unknown" } });
		const good = await signClaim(claimFields(), reg);
		const claimWith = (field: string, value: unknown) => ({ ...good, claim: { ...good.claim, [field]: value } });
		const sigWith = (field: string, value: unknown) => ({ ...good, sig: { ...good.sig, [field]: value } });
		const shapes: unknown[] = [
			undefined,
			null,
			"claim",
			[],
			{ claim: good.claim },
			{ ...good, extra: 1 },
			claimWith("extra", 1),
			sigWith("extra", 1),
			sigWith("alg", "ES256"),
			sigWith("keyId", ""),
			sigWith("sig", 5),
			claimWith("accountId", ""),
			claimWith("placementId", 3),
			claimWith("epoch", -0),
			claimWith("epoch", 1.5),
			claimWith("epoch", -1),
			claimWith("epoch", Number.NaN),
			claimWith("expiresAt", Number.POSITIVE_INFINITY),
			claimWith("issuedAt", 2 ** 53),
			claimWith("registryGeneration", "1"),
			claimWith("epoch", undefined),
		];
		for (const shape of shapes) expect(await verifyPlacementClaim(shape, trust, AT)).toBe("malformed");
	});
});

describe("claim verdicts on the wire (custody design 4.6, 15.14 M-3, C.P1)", () => {
	it("maps every refusal to its provider.call.error code and retryability", () => {
		expect(CLAIM_VERDICT_ERRORS).toEqual({
			invalid: { code: "stale_epoch", retryable: false },
			malformed: { code: "claim_invalid", retryable: false },
			expired: { code: "claim_expired", retryable: true },
			superseded: { code: "registry_key_revoked", retryable: true },
			unknown: { code: "registry_key_unknown", retryable: true },
		});
	});
});
