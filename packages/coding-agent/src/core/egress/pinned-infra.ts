/**
 * Shipped custody-infrastructure pins and the ONE device-side key check (custody design 3.1, 6.6(a)).
 *
 * The party being checked supplies only the key facts; account ids, the KMS ARN namespace, role names and
 * policy templates are constants in this release. Until the custody account exists no account id is
 * pinned, so every check fails closed as `mismatch`.
 */
import { canonicalJson, toStoreValue } from "@earendil-works/pi-agent-core";
import { decodeBase64 } from "./ecdsa-p256.ts";
import {
	type KeyFactsAnswer,
	type KmsKeyFacts,
	MAX_FACTS_AGE_MS,
	MAX_FACTS_FUTURE_SKEW_MS,
} from "./key-facts-client.ts";
import {
	type CustodyRoleArns,
	KEY_POLICY_TEMPLATE_V1,
	type KeyPolicyKind,
	type KeyPolicyTemplate,
} from "./key-policy-template.ts";
import type { ServiceKeyEntry } from "./roster-entries.ts";
import type { VerifierKeyPin } from "./signed-statement.ts";

export type CustodyRole = keyof CustodyRoleArns;

export interface PinnedCustodyInfra {
	readonly custodyAccountIds: readonly string[];
	/** Exact ARN prefix up to the account component, e.g. `arn:aws:kms:us-east-1:`. */
	readonly arnNamespace: string;
	readonly roleNames: Readonly<Record<CustodyRole, readonly string[]>>;
	readonly templates: Readonly<Record<number, KeyPolicyTemplate>>;
	/** Transport only, never a trust anchor (15.10); `undefined` until the verifier is deployed. */
	readonly keyFactsEndpoint: string | undefined;
	/** The verifier signing keys this release trusts (three consecutive generations once minted, 15.15 M-2). */
	readonly keyFactsVerifierKeys: readonly VerifierKeyPin[];
}

export const PINNED_CUSTODY_INFRA: PinnedCustodyInfra = {
	custodyAccountIds: [],
	arnNamespace: "arn:aws:kms:us-east-1:",
	roleNames: {
		runtime: ["custody-runtime"],
		registrySigner: ["registry-signer"],
		provisioning: ["custody-provisioning"],
		reader: ["key-facts-reader"],
		breakglass: ["custody-breakglass"],
	},
	templates: { 1: KEY_POLICY_TEMPLATE_V1 },
	keyFactsEndpoint: undefined,
	keyFactsVerifierKeys: [],
};

export type ServiceKeyCheckReason =
	| "ok"
	| "template-unknown"
	| "facts-unknown"
	| "facts-stale"
	| "shape"
	| "arn"
	| "arn-namespace"
	| "account-not-pinned"
	| "key-usage"
	| "key-property"
	| "spki"
	| "principal-id"
	| "role-outside-pins"
	| "policy";

export interface ServiceKeyCheck {
	readonly result: "ok" | "mismatch" | "unknown";
	readonly reason: ServiceKeyCheckReason;
	/** The device notice for this outcome, when the user can act on it. */
	readonly notice?: string;
}

const SERVICE_KEY_NOTICES: Partial<Record<ServiceKeyCheckReason, string>> = {
	"template-unknown": "update omo to trust the new custody key",
	"facts-stale": "the custody key facts are out of date; check this device's clock",
	"principal-id": "the custody key's access policy no longer matches; cloud custody for this key is unavailable",
};

const KMS_KEY_ARN =
	/^(arn:[a-z0-9-]+:kms:[a-z0-9-]+:)(\d{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE_ORDER: readonly CustodyRole[] = ["runtime", "registrySigner", "provisioning", "reader", "breakglass"];

export function roleArn(accountId: string, roleName: string): string {
	return `arn:aws:iam::${accountId}:role/${roleName}`;
}

function roleCombinations(accountId: string, pinned: PinnedCustodyInfra): CustodyRoleArns[] {
	let partial: Partial<Record<CustodyRole, string>>[] = [{}];
	for (const role of ROLE_ORDER) {
		partial = partial.flatMap((done) =>
			pinned.roleNames[role].map((name) => ({ ...done, [role]: roleArn(accountId, name) })),
		);
	}
	return partial.flatMap(({ runtime, registrySigner, provisioning, reader, breakglass }) =>
		runtime && registrySigner && provisioning && reader && breakglass
			? [{ runtime, registrySigner, provisioning, reader, breakglass }]
			: [],
	);
}

function parsePolicy(
	policy: string,
): { readonly canonical: string; readonly principals: readonly string[] } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(policy);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("Statement" in parsed) || !Array.isArray(parsed.Statement))
		return undefined;
	const principals: string[] = [];
	for (const statement of parsed.Statement) {
		const aws: unknown = statement?.Principal?.AWS;
		for (const value of Array.isArray(aws) ? aws : [aws]) {
			if (typeof value !== "string") return undefined;
			principals.push(value);
		}
	}
	return { canonical: canonicalJson(toStoreValue(parsed)), principals };
}

function sameSpki(a: string, b: string): boolean {
	const left = decodeBase64(a);
	const right = decodeBase64(b);
	return left !== undefined && right !== undefined && Buffer.from(left).equals(Buffer.from(right));
}

interface ExpectedKey {
	readonly usage: KmsKeyFacts["keyUsage"];
	readonly spki: string;
	readonly kind: KeyPolicyKind;
}

/** Custody entries list `[kemArn, sigArn]`; a placement-registry entry lists `[sigArn]`. */
function expectedKeys(entry: ServiceKeyEntry): readonly ExpectedKey[] | undefined {
	if (entry.kind === "placement-registry") return [{ usage: "SIGN_VERIFY", spki: entry.sigPk, kind: "registry" }];
	if (!entry.kemPk) return undefined;
	return [
		{ usage: "KEY_AGREEMENT", spki: entry.kemPk, kind: "custody-kem" },
		{ usage: "SIGN_VERIFY", spki: entry.sigPk, kind: "custody-sig" },
	];
}

function checkOneKey(
	arn: string,
	facts: KmsKeyFacts,
	expected: ExpectedKey,
	template: KeyPolicyTemplate,
	pinned: PinnedCustodyInfra,
): ServiceKeyCheckReason {
	const match = KMS_KEY_ARN.exec(arn);
	const accountId = match?.[2];
	if (!match || !accountId) return "arn";
	if (match[1] !== pinned.arnNamespace) return "arn-namespace";
	if (!pinned.custodyAccountIds.includes(accountId)) return "account-not-pinned";
	if (facts.keyUsage !== expected.usage) return "key-usage";
	if (
		facts.origin !== "AWS_KMS" ||
		facts.keyManager !== "CUSTOMER" ||
		facts.keyState !== "Enabled" ||
		facts.keySpec !== "ECC_NIST_P256" ||
		facts.multiRegion ||
		facts.tags["omo-custody"] !== "true" ||
		facts.grantCount !== 0
	) {
		return "key-property";
	}
	if (!sameSpki(facts.spki, expected.spki)) return "spki";
	const policy = parsePolicy(facts.policy);
	if (!policy) return "policy";
	if (policy.principals.some((principal) => !principal.startsWith("arn:"))) return "principal-id";
	const combinations = roleCombinations(accountId, pinned);
	const pinnedArns = new Set(combinations.flatMap((roles) => Object.values(roles)));
	if (policy.principals.some((principal) => !pinnedArns.has(principal))) return "role-outside-pins";
	const matches = combinations.some(
		(roles) => template.render({ accountId, keyKind: expected.kind, roles }) === policy.canonical,
	);
	return matches ? "ok" : "policy";
}

function isFresh(facts: KmsKeyFacts, now: number): boolean {
	return now - facts.readAt <= MAX_FACTS_AGE_MS && facts.readAt - now <= MAX_FACTS_FUTURE_SKEW_MS;
}

export interface ServiceKeyCheckOptions {
	/** Wall-clock now (ms since epoch) used for the facts' age. */
	readonly now: number;
	readonly pinned?: PinnedCustodyInfra;
}

function outcome(result: ServiceKeyCheck["result"], reason: ServiceKeyCheckReason): ServiceKeyCheck {
	const notice = SERVICE_KEY_NOTICES[reason];
	return notice === undefined ? { result, reason } : { result, reason, notice };
}

/** `facts` maps each of `entry.kmsKeyArns` to the verifier's answer for exactly that ARN. */
export function checkServiceKeyDetailed(
	entry: ServiceKeyEntry,
	facts: ReadonlyMap<string, KeyFactsAnswer>,
	options: ServiceKeyCheckOptions,
): ServiceKeyCheck {
	const pinned = options.pinned ?? PINNED_CUSTODY_INFRA;
	const template = pinned.templates[entry.templateVersion];
	if (!template) return outcome("unknown", "template-unknown");
	const expected = expectedKeys(entry);
	if (!expected || entry.kmsKeyArns.length !== expected.length || new Set(entry.kmsKeyArns).size !== expected.length) {
		return outcome("mismatch", "shape");
	}
	const known: KmsKeyFacts[] = [];
	for (const arn of entry.kmsKeyArns) {
		const fact = facts.get(arn);
		if (fact === undefined || fact === "unknown") return outcome("unknown", "facts-unknown");
		if ("refusal" in fact) return outcome("unknown", "facts-stale");
		if (!isFresh(fact, options.now)) return outcome("unknown", "facts-stale");
		known.push(fact);
	}
	for (const [index, key] of expected.entries()) {
		const arn = entry.kmsKeyArns[index];
		const fact = known[index];
		if (arn === undefined || fact === undefined) return outcome("mismatch", "shape");
		const reason = checkOneKey(arn, fact, key, template, pinned);
		if (reason !== "ok") return outcome("mismatch", reason);
	}
	return outcome("ok", "ok");
}

export function checkServiceKey(
	entry: ServiceKeyEntry,
	facts: ReadonlyMap<string, KeyFactsAnswer>,
	options: ServiceKeyCheckOptions,
): "ok" | "mismatch" | "unknown" {
	return checkServiceKeyDetailed(entry, facts, options).result;
}
