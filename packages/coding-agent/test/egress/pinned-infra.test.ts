import { describe, expect, it } from "vitest";
import {
	type KeyFactsAnswer,
	type KmsKeyFacts,
	MAX_FACTS_AGE_MS,
	MAX_FACTS_FUTURE_SKEW_MS,
} from "../../src/core/egress/key-facts-client.ts";
import { KEY_POLICY_TEMPLATE_V1, type KeyPolicyKind } from "../../src/core/egress/key-policy-template.ts";
import {
	checkServiceKey,
	checkServiceKeyDetailed,
	PINNED_CUSTODY_INFRA,
	type PinnedCustodyInfra,
	roleArn,
} from "../../src/core/egress/pinned-infra.ts";
import type { ServiceKeyEntry } from "../../src/core/egress/roster-entries.ts";

const NOW = 50_000_000;
const ACCOUNT = "111122223333";
const pinned: PinnedCustodyInfra = {
	...PINNED_CUSTODY_INFRA,
	custodyAccountIds: [ACCOUNT, "444455556666"],
	roleNames: { ...PINNED_CUSTODY_INFRA.roleNames, runtime: ["custody-runtime", "custody-runtime-n1"] },
};
const opts = { now: NOW, pinned };
const kemArn = `arn:aws:kms:us-east-1:${ACCOUNT}:key/00000000-0000-4000-8000-0000000000aa`;
const sigArn = `arn:aws:kms:us-east-1:${ACCOUNT}:key/00000000-0000-4000-8000-0000000000bb`;
const KEM_SPKI = Buffer.from("kem-spki-bytes").toString("base64");
const SIG_SPKI = Buffer.from("sig-spki-bytes").toString("base64");

const roles = (runtime = "custody-runtime") => ({
	runtime: roleArn(ACCOUNT, runtime),
	registrySigner: roleArn(ACCOUNT, "registry-signer"),
	provisioning: roleArn(ACCOUNT, "custody-provisioning"),
	reader: roleArn(ACCOUNT, "key-facts-reader"),
	breakglass: roleArn(ACCOUNT, "custody-breakglass"),
});

function facts(kind: KeyPolicyKind, overrides: Partial<KmsKeyFacts> = {}): KmsKeyFacts {
	return {
		spki: kind === "custody-kem" ? KEM_SPKI : SIG_SPKI,
		origin: "AWS_KMS",
		keySpec: "ECC_NIST_P256",
		keyUsage: kind === "custody-kem" ? "KEY_AGREEMENT" : "SIGN_VERIFY",
		keyManager: "CUSTOMER",
		keyState: "Enabled",
		multiRegion: false,
		tags: { "omo-custody": "true" },
		policy: KEY_POLICY_TEMPLATE_V1.render({ accountId: ACCOUNT, keyKind: kind, roles: roles() }),
		grantCount: 0,
		readAt: NOW - 1_000,
		verifierKeyId: "verifier-1",
		...overrides,
	};
}

const custody: ServiceKeyEntry = {
	kind: "custody",
	accountId: "omo-account",
	generation: 1,
	kemKeyId: "kem-1",
	kemPk: KEM_SPKI,
	sigKeyId: "sig-1",
	sigPk: SIG_SPKI,
	kmsKeyArns: [kemArn, sigArn],
	templateVersion: 1,
	role: "current",
	createdAt: 1,
	serviceSig: { alg: "ECDSA-P256-SHA256", keyId: "sig-1", sig: "AA==" },
	attestations: [],
};
const { kemKeyId: _kemKeyId, kemPk: _kemPk, ...signingOnly } = custody;
const registry: ServiceKeyEntry = { ...signingOnly, kind: "placement-registry", kmsKeyArns: [sigArn] };

const custodyFacts = (kem: Partial<KmsKeyFacts> = {}, sig: Partial<KmsKeyFacts> = {}) =>
	new Map<string, KmsKeyFacts | "unknown">([
		[kemArn, facts("custody-kem", kem)],
		[sigArn, facts("custody-sig", sig)],
	]);

describe("checkServiceKey", () => {
	it("accepts custody and registry keys that match every pin", () => {
		expect(checkServiceKeyDetailed(custody, custodyFacts(), opts)).toMatchObject({ result: "ok", reason: "ok" });
		expect(checkServiceKey(registry, new Map([[sigArn, facts("registry")]]), opts)).toBe("ok");
	});

	it("accepts a pinned next-generation role name and a non-canonical but equal policy", () => {
		const policy = KEY_POLICY_TEMPLATE_V1.render({
			accountId: ACCOUNT,
			keyKind: "custody-kem",
			roles: roles("custody-runtime-n1"),
		});
		expect(checkServiceKey(custody, custodyFacts({ policy }), opts)).toBe("ok");
		const pretty = JSON.stringify(JSON.parse(facts("custody-kem").policy), null, 2);
		expect(checkServiceKey(custody, custodyFacts({ policy: pretty }), opts)).toBe("ok");
	});

	it("fails closed in this release: no custody account is pinned yet", () => {
		expect(checkServiceKeyDetailed(custody, custodyFacts(), { now: NOW })).toMatchObject({
			result: "mismatch",
			reason: "account-not-pinned",
		});
	});

	it.each([
		[
			"a key in an unpinned account",
			{ kmsKeyArns: [kemArn.replace(ACCOUNT, "999999999999"), sigArn] },
			"account-not-pinned",
		],
		["a key in another region", { kmsKeyArns: [kemArn.replace("us-east-1", "eu-west-1"), sigArn] }, "arn-namespace"],
		["an alias ARN", { kmsKeyArns: [`arn:aws:kms:us-east-1:${ACCOUNT}:alias/custody`, sigArn] }, "arn"],
		[
			"an account component with a suffix",
			{ kmsKeyArns: [kemArn.replace(`${ACCOUNT}:`, `${ACCOUNT}0:`), sigArn] },
			"arn",
		],
		["the same ARN twice", { kmsKeyArns: [sigArn, sigArn] }, "shape"],
	] as const)("refuses %s", (_name, entryOverrides, reason) => {
		const entry = { ...custody, ...entryOverrides };
		const [first = "", second = ""] = entry.kmsKeyArns;
		const byArn = new Map<string, KmsKeyFacts | "unknown">([
			[second, facts("custody-sig")],
			[first, facts("custody-kem")],
		]);
		expect(checkServiceKeyDetailed(entry, byArn, opts)).toMatchObject({ result: "mismatch", reason });
	});

	it.each([
		["imported key material", { origin: "EXTERNAL" }],
		["an AWS-managed key", { keyManager: "AWS" }],
		["a disabled key", { keyState: "Disabled" }],
		["a key pending deletion", { keyState: "PendingDeletion" }],
		["a multi-region key", { multiRegion: true }],
		["a key with a grant", { grantCount: 1 }],
		["a key without the custody tag", { tags: {} }],
	] as const)("refuses %s", (_name, kem) => {
		expect(checkServiceKeyDetailed(custody, custodyFacts(kem), opts)).toMatchObject({
			result: "mismatch",
			reason: "key-property",
		});
	});

	it("compares public keys as decoded bytes", () => {
		expect(checkServiceKeyDetailed(custody, custodyFacts({ spki: SIG_SPKI }), opts).reason).toBe("spki");
		expect(checkServiceKey({ ...custody, kemPk: "AQ==" }, custodyFacts({ spki: "AR==" }), opts)).toBe("ok");
	});

	it("takes the key kind from the ARN position, cross-checked against the key usage", () => {
		const swappedArns = { ...custody, kmsKeyArns: [sigArn, kemArn] };
		expect(checkServiceKeyDetailed(swappedArns, custodyFacts(), opts).reason).toBe("key-usage");
		const sigPolicyOnKem = custodyFacts({ policy: facts("custody-sig").policy });
		expect(checkServiceKeyDetailed(custody, sigPolicyOnKem, opts).reason).toBe("policy");
	});

	it("refuses a policy naming a role outside the pins", () => {
		const policy = KEY_POLICY_TEMPLATE_V1.render({
			accountId: ACCOUNT,
			keyKind: "custody-kem",
			roles: roles("attacker-role"),
		});
		expect(checkServiceKeyDetailed(custody, custodyFacts({ policy }), opts).reason).toBe("role-outside-pins");
	});

	it("refuses a policy whose principal is rendered as a unique principal id", () => {
		const policy = facts("custody-kem").policy.replace(
			roleArn(ACCOUNT, "custody-breakglass"),
			"AROAEXAMPLEUNIQUEID01",
		);
		expect(checkServiceKeyDetailed(custody, custodyFacts({ policy }), opts)).toMatchObject({
			result: "mismatch",
			reason: "principal-id",
		});
	});

	it("refuses pinned principals with an extra action", () => {
		const widened = facts("custody-kem").policy.replace(
			'"kms:DeriveSharedSecret"',
			'"kms:DeriveSharedSecret","kms:PutKeyPolicy"',
		);
		expect(checkServiceKeyDetailed(custody, custodyFacts({ policy: widened }), opts).reason).toBe("policy");
	});

	it("answers unknown, never ok, for an unknown template version or missing or unknown facts", () => {
		expect(checkServiceKeyDetailed({ ...custody, templateVersion: 2 }, custodyFacts(), opts)).toMatchObject({
			result: "unknown",
			reason: "template-unknown",
		});
		expect(checkServiceKey(custody, new Map([[kemArn, facts("custody-kem")]]), opts)).toBe("unknown");
		expect(checkServiceKey(custody, new Map([...custodyFacts(), [sigArn, "unknown"]]), opts)).toBe("unknown");
	});

	it.each([
		["older than the age limit", NOW - MAX_FACTS_AGE_MS - 1],
		["dated beyond the future skew", NOW + MAX_FACTS_FUTURE_SKEW_MS + 1],
	])("answers unknown for stale facts: %s", (_name, readAt) => {
		expect(checkServiceKeyDetailed(custody, custodyFacts({}, { readAt }), opts)).toMatchObject({
			result: "unknown",
			reason: "facts-stale",
		});
	});

	it("shows the clock notice when the reader refused the facts as stale", () => {
		const stale = { refusal: "facts-stale" as const, skewMs: 200_000 };
		expect(
			checkServiceKeyDetailed(
				custody,
				new Map<string, KeyFactsAnswer>([
					[kemArn, stale],
					[sigArn, facts("custody-sig")],
				]),
				opts,
			),
		).toEqual({
			result: "unknown",
			reason: "facts-stale",
			notice: "the custody key facts are out of date; check this device's clock",
		});
	});

	it("accepts facts exactly at the age and skew limits", () => {
		expect(
			checkServiceKey(
				custody,
				custodyFacts({ readAt: NOW - MAX_FACTS_AGE_MS }, { readAt: NOW + MAX_FACTS_FUTURE_SKEW_MS }),
				opts,
			),
		).toBe("ok");
	});

	it("carries a device notice exactly for the outcomes the user can act on", () => {
		const principalId = facts("custody-kem").policy.replace(
			roleArn(ACCOUNT, "custody-breakglass"),
			"AROAEXAMPLEUNIQUEID01",
		);
		expect(checkServiceKeyDetailed(custody, custodyFacts({ policy: principalId }), opts).notice).toBeTypeOf("string");
		expect(checkServiceKeyDetailed({ ...custody, templateVersion: 2 }, custodyFacts(), opts).notice).toBeTypeOf(
			"string",
		);
		expect(checkServiceKeyDetailed(custody, custodyFacts({}, { readAt: 0 }), opts).notice).toBeTypeOf("string");
		expect(checkServiceKeyDetailed(custody, custodyFacts({ grantCount: 1 }), opts).notice).toBeUndefined();
		expect(checkServiceKeyDetailed(custody, custodyFacts(), opts).notice).toBeUndefined();
	});
});

describe("KEY_POLICY_TEMPLATE_V1", () => {
	it.each(["custody-kem", "custody-sig", "registry"] as const)(
		"grants only pinned roles and no policy, grant or replica edit (%s)",
		(kind) => {
			const statements: { Sid: string; Principal: { AWS: string }; Action: string[] }[] = JSON.parse(
				KEY_POLICY_TEMPLATE_V1.render({ accountId: ACCOUNT, keyKind: kind, roles: roles() }),
			).Statement;
			expect(statements.map((statement) => statement.Sid)).toEqual(["Use", "Admin", "Read", "BreakGlass"]);
			for (const statement of statements) {
				expect(statement.Principal.AWS).toMatch(new RegExp(`^arn:aws:iam::${ACCOUNT}:role/[a-z-]+$`));
				expect(
					statement.Action.filter((action) => /PutKeyPolicy|CreateGrant|ReplicateKey|\*/.test(action)),
				).toEqual([]);
			}
		},
	);
});
