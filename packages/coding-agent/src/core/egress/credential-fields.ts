import type { ApiKeyCredential, OAuthCredential } from "@earendil-works/pi-ai";
import type { CredentialSlot, PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import type { FieldClass } from "./classify.ts";

type DeclaredKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };
type Classified<T> = { readonly [K in DeclaredKeys<T>]-?: FieldClass };

const API_KEY_CREDENTIAL_FIELDS = {
	type: "public",
	key: "sealed",
	env: "forces-device",
	loginId: "device-only",
} as const satisfies Classified<ApiKeyCredential>;

const OAUTH_CREDENTIAL_FIELDS = {
	type: "public",
	access: "sealed",
	refresh: "device-only",
	expires: "public",
	idToken: "device-only",
	subject: "device-only",
	email: "device-only",
	issuer: "device-only",
	clientId: "device-only",
	scopes: "device-only",
	planUsageEnabled: "public",
	// The ChatGPT sign-in route: a two-value protocol selector ("siwc" | "codex") the request needs, no secret material.
	route: "public",
	loginId: "device-only",
} as const satisfies Classified<OAuthCredential>;

export const CREDENTIAL_SLOT_FIELDS = {
	name: "public",
	displayName: "device-only",
	source: "public",
	key: "sealed",
	access: "sealed",
	refresh: "device-only",
	expires: "public",
	// The slot's ChatGPT sign-in route: a two-value protocol selector ("siwc" | "codex"), no secret material.
	route: "public",
	env: "forces-device",
} as const satisfies Classified<CredentialSlot>;

type PoolExtras = Omit<PooledCredential, keyof ApiKeyCredential | keyof OAuthCredential>;

const POOLED_CREDENTIAL_FIELDS = {
	accounts: CREDENTIAL_SLOT_FIELDS,
	pinned: "public",
	order: "public",
} as const satisfies { readonly [K in DeclaredKeys<PoolExtras>]-?: FieldClass | Classified<CredentialSlot> };

/** A stored credential key outside the declared fields (OAuth flows may add any) keeps the credential on the device. */
export function classifyCredentialField(type: "api_key" | "oauth", key: string): FieldClass {
	const table: Readonly<Record<string, FieldClass>> =
		type === "api_key" ? API_KEY_CREDENTIAL_FIELDS : OAUTH_CREDENTIAL_FIELDS;
	return (Object.hasOwn(table, key) ? table[key] : undefined) ?? "forces-device";
}

export type CredentialDeviceReason = "env" | "undeclared-field";

function forcesDevice(table: Readonly<Record<string, unknown>>, key: string, value: unknown): CredentialDeviceReason[] {
	const fieldClass = Object.hasOwn(table, key) ? table[key] : undefined;
	if (fieldClass === undefined) return ["undeclared-field"];
	if (fieldClass !== "forces-device") return [];
	return typeof value === "object" && value !== null && Object.keys(value).length === 0 ? [] : ["env"];
}

/** Why a stored auth.json credential must be used on the device; empty when sealed custody can compose its requests. */
export function credentialDeviceReasons(
	credential: Readonly<Record<string, unknown>>,
): readonly CredentialDeviceReason[] {
	const reasons = new Set<CredentialDeviceReason>();
	const typeTable =
		credential.type === "api_key"
			? API_KEY_CREDENTIAL_FIELDS
			: credential.type === "oauth"
				? OAUTH_CREDENTIAL_FIELDS
				: undefined;
	if (typeTable === undefined) return ["undeclared-field"];
	const table = { ...typeTable, ...POOLED_CREDENTIAL_FIELDS };
	for (const [key, value] of Object.entries(credential)) {
		for (const reason of forcesDevice(table, key, value)) reasons.add(reason);
	}
	const accounts = credential.accounts;
	if (accounts !== undefined && !Array.isArray(accounts)) reasons.add("undeclared-field");
	for (const account of Array.isArray(accounts) ? accounts : []) {
		if (typeof account !== "object" || account === null) {
			reasons.add("undeclared-field");
			continue;
		}
		for (const [key, value] of Object.entries(account)) {
			for (const reason of forcesDevice(CREDENTIAL_SLOT_FIELDS, key, value)) reasons.add(reason);
		}
	}
	return [...reasons];
}
