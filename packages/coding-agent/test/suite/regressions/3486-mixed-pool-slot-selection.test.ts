import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listRotationSlots, streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

/**
 * senpi#3486 review: older builds left mixed pools (an API key appended under an OAuth login).
 * Per-session slot selection could pick the key slot, which the OAuth credential cannot project,
 * so that session resolved no credential. Selection must only consider slots of the credential's
 * own kind: every session gets the working OAuth login, none the unusable key.
 */
const expires = 4_102_444_800_000;
function mixed(): PooledCredential {
	return {
		type: "oauth",
		access: "access-default",
		refresh: "refresh-default",
		expires,
		accounts: [
			{ name: "default", source: "login", access: "access-default", refresh: "refresh-default", expires },
			{ name: "login-2", source: "login", key: "sk-unused-key" },
		],
	};
}

describe("a mixed pool never hands a session the slot of the other kind (senpi#3486)", () => {
	let dir: string;
	let repository: CredentialSlotRepository;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-3486-mixed-"));
		repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const sources = () => ({ providerId: "openrouter", credential: mixed(), env: () => undefined, repository });

	test("rotation lists only the OAuth slots", async () => {
		const slots = await listRotationSlots(sources(), { acquireLeases: false });
		expect(slots.map((slot) => slot.name)).toEqual(["default"]);
	});

	test("every session runs on a working OAuth login", async () => {
		const used = new Set<string>();
		for (let session = 0; session < 64; session++) {
			const stream = streamWithCredentialRotation({
				sources: sources(),
				affinityKey: `session-${session}`,
				runAttempt: (slot) => {
					used.add(slot.name);
					return (async function* (): AsyncGenerator<AssistantMessageEvent> {})();
				},
			});
			try {
				for await (const _event of stream) {
					// drain
				}
			} catch {
				// An empty attempt may end as a failure; only which slots ran matters here.
			}
		}
		expect([...used]).toEqual(["default"]);
	});
});
