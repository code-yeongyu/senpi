import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#4090: `credential-pool-state.json` is shared by every engine version installed on a
// machine (the CLI, the desktop app's bundled engine, an older omo). Its schema was strict, so a
// file carrying one field a newer engine writes made an older engine treat the whole document as
// invalid and replace it with a fresh one, dropping every provider's blocks. Unknown fields must
// be read past, and a write must keep them.

const INSTALLATION_KEY = "a".repeat(64);
const REVISION = "b".repeat(64);
const BLOCKED_UNTIL = 1_900_000_000_000;

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-4090-state-"));
	path = join(dir, "credential-pool-state.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeNewerEngineDocument(): void {
	writeFileSync(
		path,
		JSON.stringify({
			schemaVersion: 1,
			installationKey: INSTALLATION_KEY,
			writtenBy: "a newer engine",
			providers: {
				"chatgpt-subscription": {
					providerNote: "provider field",
					lanes: {
						stored: {
							laneNote: "lane field",
							slots: {
								alpha: {
									stateVersion: 3,
									blockedUntil: BLOCKED_UNTIL,
									blockReason: "rate_limit",
									failureCount: 2,
									credentialRevision: REVISION,
									blockedAt: BLOCKED_UNTIL - 60_000,
								},
							},
						},
					},
				},
			},
		}),
		{ mode: 0o600 },
	);
}

describe("senpi#4090: the pool health file reads past fields a newer engine wrote", () => {
	it("#given a slot with an unknown field #when an engine lists the slots #then the block is kept", async () => {
		writeNewerEngineDocument();
		const repository = new CredentialSlotRepository(path);

		const slots = await repository.listSlots("chatgpt-subscription", "stored");

		expect(slots.alpha?.blockedUntil).toBe(BLOCKED_UNTIL);
		expect(slots.alpha?.blockReason).toBe("rate_limit");
		expect(await repository.installationKey()).toBe(INSTALLATION_KEY);
	});

	it("#given that document #when another slot is written #then the unknown fields and the other block survive", async () => {
		writeNewerEngineDocument();
		const repository = new CredentialSlotRepository(path);

		await repository.mutateSlotState("chatgpt-subscription", "stored", "bravo", () => ({ failureCount: 1 }));

		const stored = JSON.parse(readFileSync(path, "utf8"));
		expect(stored.installationKey).toBe(INSTALLATION_KEY);
		expect(stored.writtenBy).toBe("a newer engine");
		expect(stored.providers["chatgpt-subscription"].lanes.stored.slots.alpha.blockedAt).toBe(BLOCKED_UNTIL - 60_000);
		expect(stored.providers["chatgpt-subscription"].lanes.stored.slots.alpha.blockedUntil).toBe(BLOCKED_UNTIL);
	});

	it("#given that document #when a slot in that lane is written #then the provider's and the lane's unknown fields survive", async () => {
		writeNewerEngineDocument();
		const repository = new CredentialSlotRepository(path);

		await repository.mutateSlotState("chatgpt-subscription", "stored", "bravo", () => ({ failureCount: 1 }));

		const provider = JSON.parse(readFileSync(path, "utf8")).providers["chatgpt-subscription"];
		expect(provider.providerNote).toBe("provider field");
		expect(provider.lanes.stored.laneNote).toBe("lane field");
		expect(provider.lanes.stored.slots.bravo.failureCount).toBe(1);
	});

	// Reading past unknown fields must not loosen what this engine writes: a wrong-typed known field
	// would be written, fail the schema on the next read, and reset the whole file. `tsc` checks this.
	it("#given the loose schema #when a slot write is typed #then its known fields keep their types", () => {
		type SlotWrite = NonNullable<ReturnType<Parameters<CredentialSlotRepository["mutateSlotState"]>[3]>>;

		expectTypeOf<SlotWrite["blockedUntil"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<SlotWrite["blockReason"]>().toEqualTypeOf<
			"auth_error" | "rate_limit" | "account_disabled" | undefined
		>();
	});
});
