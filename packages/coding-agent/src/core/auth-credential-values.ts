import { dirname } from "node:path";
import type { ApiKeyCredential, Credential } from "@earendil-works/pi-ai";
import { projectSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	type ConfigReference,
	ConfigReferenceError,
	isConfigReference,
} from "@earendil-works/pi-ai/utils/config-reference";
import { resolveConfigReference } from "./config-reference-resolver.ts";
import { isCommandConfigValue, resolveConfigValue } from "./resolve-config-value.ts";

export interface StoredSlotRead {
	readonly providerId: string;
	readonly slotName: string;
	readonly authPath: string | undefined;
}

interface StoredReference {
	readonly field: string;
	readonly authPath: string | undefined;
	readonly env: ApiKeyCredential["env"];
}

function assertKeyShape(value: unknown, field: string): void {
	if (typeof value === "object" && value !== null && !isConfigReference(value)) {
		throw new ConfigReferenceError(field, value, "malformed");
	}
}

function assertCredentialReferences(providerId: string, credential: object): void {
	if ("type" in credential && credential.type === "api_key" && "key" in credential) {
		assertKeyShape(credential.key, `${providerId}.key`);
	}
	if (!("accounts" in credential) || !Array.isArray(credential.accounts)) return;
	for (const [index, account] of credential.accounts.entries()) {
		if (typeof account === "object" && account !== null && "key" in account) {
			assertKeyShape(account.key, `${providerId}.accounts.${index}.key`);
		}
	}
}

/** auth.json is trusted user configuration, so a reference resolves against the file that declares it. */
function resolveStoredReference(reference: ConfigReference, source: StoredReference): Promise<string> {
	const context =
		source.authPath === undefined
			? undefined
			: { origin: source.authPath, baseDir: dirname(source.authPath), authority: "trusted", field: source.field };
	return resolveConfigReference(reference, context, source.env && { ...process.env, ...source.env });
}

export function validateReadOnlyAuthData(parsed: unknown): void {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid auth.json: expected an object");
	}
	for (const [providerId, credential] of Object.entries(parsed)) {
		if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
		}
		assertCredentialReferences(providerId, credential);
		const value = credential as Record<string, unknown>;
		if (value.type === "api_key") {
			const validKey = value.key === undefined || typeof value.key === "string" || isConfigReference(value.key);
			const validEnv =
				value.env === undefined ||
				(typeof value.env === "object" &&
					value.env !== null &&
					!Array.isArray(value.env) &&
					Object.values(value.env).every((entry) => typeof entry === "string"));
			if (validKey && validEnv) continue;
		} else if (
			value.type === "oauth" &&
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires)
		) {
			continue;
		}
		throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
	}
}

export async function resolveReadOnlyCredential(
	credential: Credential | undefined,
	providerId: string,
	authPath: string,
): Promise<Credential | undefined> {
	if (!credential) return undefined;
	const key: unknown = credential.type === "api_key" ? credential.key : undefined;
	if (credential.type === "api_key" && isConfigReference(key)) {
		const field = `${providerId}.key`;
		return { ...credential, key: await resolveStoredReference(key, { field, authPath, env: credential.env }) };
	}
	if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
		return structuredClone(credential);
	}
	return { ...credential, key: await resolveConfigValue(credential.key, credential.env) };
}

export async function resolveStoredCredential(
	credential: Credential | undefined,
	providerId: string,
	authPath: string | undefined,
): Promise<Credential | undefined> {
	if (credential?.type !== "api_key") return credential;
	assertCredentialReferences(providerId, credential);
	if (credential.key === undefined) return credential;
	const key: unknown = credential.key;
	if (isConfigReference(key)) {
		const field = `${providerId}.key`;
		return { ...credential, key: await resolveStoredReference(key, { field, authPath, env: credential.env }) };
	}
	return { ...credential, key: await resolveConfigValue(credential.key, credential.env) };
}

/**
 * A slot-scoped read resolves only the selected slot's reference, never the flat key or a sibling.
 * A flat credential is its one `default` slot, read exactly as `read` reads it.
 */
export async function resolveStoredSlot(
	credential: Credential | undefined,
	slot: StoredSlotRead,
	readFlat: (credential: Credential) => Promise<Credential | undefined>,
): Promise<Credential | undefined> {
	if (credential === undefined) return undefined;
	assertCredentialReferences(slot.providerId, credential);
	const accounts: unknown[] =
		"accounts" in credential && Array.isArray(credential.accounts) ? credential.accounts : [];
	if (accounts.length === 0) return projectSlot(await readFlat(credential), slot.slotName);
	const projected = projectSlot(credential, slot.slotName);
	const key: unknown = projected?.type === "api_key" ? projected.key : undefined;
	if (projected?.type !== "api_key" || !isConfigReference(key)) return projected;
	const index = accounts.findIndex(
		(account) =>
			typeof account === "object" && account !== null && "name" in account && account.name === slot.slotName,
	);
	const field = `${slot.providerId}.accounts.${index}.key`;
	return {
		...projected,
		key: await resolveStoredReference(key, { field, authPath: slot.authPath, env: projected.env }),
	};
}
