/**
 * Pinned canonical KMS key-policy templates (custody design 3.1 and 6.6(a)).
 *
 * A device accepts a custody or registry key only if its policy is byte-equal to one of these templates
 * rendered for pinned role ARNs. No template contains an account-root statement or grants
 * `kms:PutKeyPolicy`, `kms:CreateGrant` or `kms:ReplicateKey` to anyone, so the checked policy holds for
 * the key's life. A template change is a new version shipped in a client release before any key uses it.
 */
import { canonicalJson } from "@earendil-works/pi-agent-core";

export type KeyPolicyKind = "custody-kem" | "custody-sig" | "registry";

export interface CustodyRoleArns {
	readonly runtime: string;
	readonly registrySigner: string;
	readonly provisioning: string;
	readonly reader: string;
	readonly breakglass: string;
}

export interface KeyPolicyTemplate {
	render(input: {
		readonly accountId: string;
		readonly keyKind: KeyPolicyKind;
		readonly roles: CustodyRoleArns;
	}): string;
}

const USE_ACTIONS = {
	"custody-kem": ["kms:DeriveSharedSecret", "kms:GetPublicKey"],
	"custody-sig": ["kms:GetPublicKey", "kms:Sign"],
	registry: ["kms:GetPublicKey", "kms:Sign"],
} as const satisfies Readonly<Record<KeyPolicyKind, readonly string[]>>;

const ADMIN_ACTIONS = [
	"kms:CancelKeyDeletion",
	"kms:DescribeKey",
	"kms:DisableKey",
	"kms:EnableKey",
	"kms:GetKeyPolicy",
	"kms:GetPublicKey",
	"kms:ScheduleKeyDeletion",
	"kms:TagResource",
] as const;
const READ_ACTIONS = [
	"kms:DescribeKey",
	"kms:GetKeyPolicy",
	"kms:GetPublicKey",
	"kms:ListGrants",
	"kms:ListResourceTags",
] as const;
const BREAKGLASS_ACTIONS = [
	"kms:CancelKeyDeletion",
	"kms:DescribeKey",
	"kms:DisableKey",
	"kms:GetKeyPolicy",
	"kms:ListGrants",
	"kms:ScheduleKeyDeletion",
] as const;

function statement(sid: string, principal: string, actions: readonly string[]) {
	return { Sid: sid, Effect: "Allow", Principal: { AWS: principal }, Action: [...actions], Resource: "*" };
}

export const KEY_POLICY_TEMPLATE_V1 = {
	render({ keyKind, roles }) {
		const user = keyKind === "registry" ? roles.registrySigner : roles.runtime;
		return canonicalJson({
			Version: "2012-10-17",
			Id: `omo-custody-${keyKind}-v1`,
			Statement: [
				statement("Use", user, USE_ACTIONS[keyKind]),
				statement("Admin", roles.provisioning, ADMIN_ACTIONS),
				statement("Read", roles.reader, READ_ACTIONS),
				statement("BreakGlass", roles.breakglass, BREAKGLASS_ACTIONS),
			],
		});
	},
} as const satisfies KeyPolicyTemplate;
