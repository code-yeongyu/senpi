import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rendezvousOrder as genericOrder, selectSlot } from "@earendil-works/pi-ai/auth/pool/select";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { renameCredentialAccount } from "../../../src/core/credential-accounts.ts";
import { listRotationSlots } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import {
	type AccountSlot,
	type ClaudeSdkOauthCredential,
	emptyCredential,
	refreshSlot,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { rendezvousOrder, selectAccount } from "../../../src/core/extensions/builtin/claude-sdk-oauth/affinity.ts";
import { runFailover } from "../../../src/core/extensions/builtin/claude-sdk-oauth/failover.ts";
import { decideNativeContinuity } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";

const provider = "claude-sdk-oauth";
const hasher = (value: string) => createHash("sha256").update(value).digest().readBigUInt64BE(0);
function fixture() {
	const accounts: AccountSlot[] = ["default", "second"].map((name) => ({
		name,
		source: "login",
		access: `fake-${name}`,
		refresh: `fake-refresh-${name}`,
		expires: 1,
	}));
	const storage = AuthStorage.inMemory({ [provider]: { ...emptyCredential(), pinned: "default", accounts } });
	return { accounts, storage };
}

// senpi#1495: renaming must not remap affinity, health, token refresh or SDK lineage.
it("keeps HRW, pins, sidecar health and Claude restart bindings keyed by the immutable name", async () => {
	const { accounts, storage } = fixture();
	const sidecarDir = mkdtempSync(join(tmpdir(), "account-display-identity-"));
	try {
		const repository = new CredentialSlotRepository(join(sidecarDir, "credential-pool-state.json"));
		await repository.mutateSlotState(provider, "stored", "second", () => ({ blockReason: "auth_error" }));
		const sources = {
			providerId: provider,
			credential: storage.get(provider),
			env: () => undefined,
			repository,
			now: () => 1000,
		};
		const rotationBefore = await listRotationSlots(sources);
		await renameCredentialAccount(storage, provider, "default", "Personal");
		await renameCredentialAccount(storage, provider, "second", "Work");
		const after = (storage.get(provider) as ClaudeSdkOauthCredential).accounts!;
		for (const session of ["one", "two", "three"]) {
			expect(rendezvousOrder(session, after).map((slot) => slot.name)).toEqual(
				rendezvousOrder(session, accounts).map((slot) => slot.name),
			);
			expect(genericOrder(session, after, hasher).map((slot) => slot.name)).toEqual(
				genericOrder(session, accounts, hasher).map((slot) => slot.name),
			);
		}
		expect(selectAccount(after, { sessionId: "one", pinnedAccount: "default" }).name).toBe("default");
		expect(selectSlot(after, { hasher, pinnedSlot: "default" }).name).toBe("default");
		expect(await listRotationSlots({ ...sources, credential: storage.get(provider) })).toEqual(rotationBefore);
		const identity = {
			accountName: selectAccount(after, { pinnedAccount: "default" }).name,
			modelId: "claude",
			systemPromptHash: "prompt",
			toolsetHash: "tools",
		};
		const decision = decideNativeContinuity({
			entry: undefined,
			binding: {
				...identity,
				accountName: "default",
				sdkSessionId: "sdk-session",
				sentCount: 1,
				sentHashes: ["first"],
				lastAssistantUuid: "assistant",
			},
			currentHashes: ["first", "next"],
			accountName: identity.accountName,
			modelId: identity.modelId,
			fingerprint: identity,
			transcriptAvailable: true,
			crossAccountResumeSupported: false,
		});
		expect(decision).toMatchObject({ kind: "reattach", sdkSessionId: "sdk-session", from: 1 });
	} finally {
		rmSync(sidecarDir, { recursive: true, force: true });
	}
});

it("refreshes and fails over by name while preserving display metadata and slot block state", async () => {
	const { storage } = fixture();
	await renameCredentialAccount(storage, provider, "default", "Personal");
	await renameCredentialAccount(storage, provider, "second", "Work");
	const refreshedTokens: string[] = [];
	await refreshSlot(
		storage,
		provider,
		"default",
		async (token) => {
			refreshedTokens.push(token);
			return { access: "fake-rotated", refresh: "fake-next", expires: 4102444800000 };
		},
		new AbortController().signal,
		() => true,
	);
	expect(refreshedTokens).toEqual(["fake-refresh-default"]);
	const attempted: string[] = [];
	const transitions: string[] = [];
	const events = runFailover({
		accounts: (storage.get(provider) as ClaudeSdkOauthCredential).accounts!,
		store: storage,
		providerId: provider,
		now: () => 1000,
		selectFn: (accounts) => selectAccount(accounts, { pinnedAccount: "default", now: 1000 }),
		classify: () => ({ kind: "rate_limit", retryable: true }),
		runAttempt: async function* (slot) {
			attempted.push(slot.name);
			if (slot.name === "default") throw new Error("synthetic rate limit");
			yield { type: "text_delta", text: "ok" };
		},
		onFailover: ({ account, nextAccount }) => {
			transitions.push(`${account.name}:${nextAccount?.name}`);
		},
	});
	for await (const event of events) expect(event.type).toBe("text_delta");
	expect(attempted).toEqual(["default", "second"]);
	expect(transitions).toEqual(["default:second"]);
	expect(listSlots(storage.get(provider))).toMatchObject([
		{ name: "default", displayName: "Personal", access: "fake-rotated", blockReason: "rate_limit" },
		{ name: "second", displayName: "Work" },
	]);
	expect(storage.get(provider)).toHaveProperty("pinned", "default");
});
