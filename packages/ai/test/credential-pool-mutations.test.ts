import { describe, expect, test } from "vitest";
import {
	type Credential,
	type CredentialSlot,
	listSlots,
	type PooledCredential,
	removeSlot,
	upsertSlot,
} from "../src/auth/pool/slots.ts";

describe("credential pool slot algebra", () => {
	function pooledApiKey(): PooledCredential {
		return {
			type: "api_key",
			key: "primary-key",
			accounts: [
				{ name: "default", key: "primary-key", source: "login" },
				{ name: "work", key: "work-key", source: "login" },
			],
			pinned: "work",
		};
	}

	function names(credential: PooledCredential | undefined): string[] {
		return listSlots(credential).map((slot) => slot.name);
	}

	test("a flat api_key credential reads as a one-slot pool", () => {
		const flat: Credential = { type: "api_key", key: "legacy-key" };
		expect(listSlots(flat)).toEqual([{ name: "default", source: "login", key: "legacy-key" }]);
	});

	test("a flat oauth credential reads as a one-slot pool carrying its tokens", () => {
		const flat: Credential = { type: "oauth", access: "a", refresh: "r", expires: 123 };
		expect(listSlots(flat)).toEqual([{ name: "default", source: "login", access: "a", refresh: "r", expires: 123 }]);
	});

	test("upsertSlot replaces one slot and keeps its siblings", () => {
		const next = upsertSlot(pooledApiKey(), { name: "default", key: "rotated", source: "login" });
		expect(names(next)).toEqual(["default", "work"]);
		expect(listSlots(next).find((slot) => slot.name === "work")?.key).toBe("work-key");
	});

	test("upsertSlot appends an unseen slot", () => {
		expect(names(upsertSlot(pooledApiKey(), { name: "personal", key: "p", source: "login" }))).toEqual([
			"default",
			"work",
			"personal",
		]);
	});

	test("upsertSlot preserves the pin", () => {
		expect(upsertSlot(pooledApiKey(), { name: "default", key: "rotated", source: "login" }).pinned).toBe("work");
	});

	test("upsertSlot leaves the flat credential usable by a build predating pools", () => {
		const next = upsertSlot({ type: "api_key", key: "legacy-key" }, { name: "second", key: "s", source: "login" });
		expect(next).toMatchObject({ type: "api_key", key: "legacy-key" });
		expect(names(next)).toEqual(["default", "second"]);
	});

	test("removeSlot deletes only the named slot", () => {
		expect(names(removeSlot(pooledApiKey(), "default"))).toEqual(["work"]);
	});

	test("removeSlot clears a pin naming the removed slot", () => {
		expect(removeSlot(pooledApiKey(), "work")?.pinned).toBeUndefined();
	});

	test("removeSlot drops the credential once its last slot is gone", () => {
		const single: PooledCredential = {
			type: "api_key",
			key: "only",
			accounts: [{ name: "default", key: "only", source: "login" }],
		};
		expect(removeSlot(single, "default")).toBeUndefined();
	});

	test("upsertSlot rejects a slot name that could collide with path syntax", () => {
		const slot = { name: "../escape", key: "k", source: "login" } as CredentialSlot;
		expect(() => upsertSlot(pooledApiKey(), slot)).toThrow(/Invalid account name/);
	});
});
