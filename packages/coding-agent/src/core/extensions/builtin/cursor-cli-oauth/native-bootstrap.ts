import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
	type CursorCliOauthCredential,
	emptyCredential,
	listAccounts,
	SENTINEL_OAUTH_FIELDS,
} from "./accounts.ts";
import { CURSOR_CLI_OAUTH_PROVIDER_ID, importNativeCursorCredential } from "./oauth-login.ts";

export type CursorCliNativeBootstrapDeps = {
	store: CredentialStore;
	readNativeCredential: () => Credential | undefined | Promise<Credential | undefined>;
	canBootstrap?: () => boolean | Promise<boolean>;
};

function asManagedCredential(credential: Credential | undefined): CursorCliOauthCredential | undefined {
	if (credential?.type !== "oauth") return undefined;
	const managed = credential as CursorCliOauthCredential;
	return Array.isArray(managed.accounts) &&
		managed.access === SENTINEL_OAUTH_FIELDS.access &&
		managed.refresh === SENTINEL_OAUTH_FIELDS.refresh &&
		managed.expires === SENTINEL_OAUTH_FIELDS.expires
		? managed
		: undefined;
}

async function bootstrapNativeCredential(deps: CursorCliNativeBootstrapDeps): Promise<Credential | undefined> {
	let current: Credential | undefined;
	try {
		current = await deps.store.read(CURSOR_CLI_OAUTH_PROVIDER_ID);
		const managed = asManagedCredential(current);
		if (managed && listAccounts(managed).length > 0) return current;
		if (current !== undefined && !managed) return current;
		if (deps.canBootstrap !== undefined && !(await deps.canBootstrap())) return current;

		const native = await deps.readNativeCredential();
		if (native === undefined) return current;

		return await deps.store.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async (latest) => {
			const latestManaged = asManagedCredential(latest);
			if (latestManaged && listAccounts(latestManaged).length > 0) return latest;
			if (latest !== undefined && !latestManaged) return latest;
			return importNativeCursorCredential(latestManaged ?? emptyCredential(), async () => native);
		});
	} catch {
		return current;
	}
}

/**
 * Read the managed credential afresh and bootstrap it once from the native
 * Cursor OAuth credential when empty. Concurrent reads share only the
 * in-flight operation; later turns re-read storage so login/import changes are
 * immediately visible.
 */
export function createCursorCliOauthCredentialReader(
	deps: CursorCliNativeBootstrapDeps,
): () => Promise<Credential | undefined> {
	let inFlight: Promise<Credential | undefined> | undefined;
	return () => {
		if (inFlight) return inFlight;
		inFlight = bootstrapNativeCredential(deps).finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	};
}
