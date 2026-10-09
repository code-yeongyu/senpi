import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRotationSlots, streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

const PROVIDER = "anthropic-subscription";
const env = () => undefined;

let dir: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stored-revision-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function storedCredential(access: string, refresh: string) {
	return {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4_102_444_800_000,
		accounts: [{ name: "default", access, refresh, expires: Date.now() + 3_600_000, source: "login" }],
	} as const;
}

async function revisionFor(provider: string, name: string, access: string, refresh: string): Promise<string> {
	const key = await repository.installationKey();
	return createHmac("sha256", key).update(`${provider}\0${name}\0\0${access}\0${refresh}`).digest("hex");
}

describe("stored-lane credential revision healing (omo#7084)", () => {
	it("drops a legacy stored-lane block that predates credential revisions", async () => {
		await repository.mutateSlotState(PROVIDER, "stored", "default", () => ({
			blockReason: "auth_error",
			failureCount: 1,
		}));
		const slots = await listRotationSlots({
			providerId: PROVIDER,
			credential: storedCredential("a1", "r1") as never,
			env,
			repository,
		});
		expect(slots).toHaveLength(1);
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("still applies a block stamped against the current material", async () => {
		const revision = await revisionFor(PROVIDER, "default", "a1", "r1");
		await repository.mutateSlotState(PROVIDER, "stored", "default", () => ({
			blockReason: "auth_error",
			failureCount: 1,
			credentialRevision: revision,
		}));
		const slots = await listRotationSlots({
			providerId: PROVIDER,
			credential: storedCredential("a1", "r1") as never,
			env,
			repository,
		});
		expect(slots[0]?.blockReason).toBe("auth_error");
	});

	it("drops a block stamped against foreign material", async () => {
		await repository.mutateSlotState(PROVIDER, "stored", "default", () => ({
			blockReason: "auth_error",
			failureCount: 1,
			credentialRevision: "0".repeat(64),
		}));
		const slots = await listRotationSlots({
			providerId: PROVIDER,
			credential: storedCredential("a1", "r1") as never,
			env,
			repository,
		});
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("drops the block once re-login replaces the slot material", async () => {
		const revision = await revisionFor(PROVIDER, "default", "a1", "r1");
		await repository.mutateSlotState(PROVIDER, "stored", "default", () => ({
			blockReason: "auth_error",
			failureCount: 2,
			credentialRevision: revision,
		}));
		const slots = await listRotationSlots({
			providerId: PROVIDER,
			credential: storedCredential("a2", "r2") as never,
			env,
			repository,
		});
		expect(slots).toHaveLength(1);
		expect(slots[0]?.blockReason).toBeUndefined();
	});

	it("stamps the material revision when a stored slot is blocked", async () => {
		const stream = streamWithCredentialRotation({
			sources: { providerId: PROVIDER, credential: storedCredential("a1", "r1") as never, env, repository },
			runAttempt: async function* () {
				yield { type: "error", error: { errorMessage: "HTTP 401 unauthorized" } } as never;
			},
		});
		// The pool has one slot, so the auth failure exhausts it; the provider's
		// own terminal event is forwarded (senpi#1628) rather than rethrown.
		const seen: string[] = [];
		for await (const event of stream) seen.push(event.type);
		expect(seen).toEqual(["error"]);
		const state = await repository.listSlots(PROVIDER, "stored");
		expect(state.default?.blockReason).toBe("auth_error");
		expect(state.default?.credentialRevision).toBe(await revisionFor(PROVIDER, "default", "a1", "r1"));
	});
});
