import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

describe("AuthStorage slot-preserving writes", () => {
	const tempDir = join(tmpdir(), `pi-test-auth-slots-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authJsonPath = join(tempDir, "auth.json");

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function writeAuthJson(data: Record<string, unknown>): void {
		writeFileSync(authJsonPath, JSON.stringify(data, null, 2));
	}

	type StoredSlot = { name: string; key?: string; source?: string };
	type StoredEntry = { type?: string; key?: string; accounts?: StoredSlot[]; pinned?: string };

	function readAuthJson(): Record<string, StoredEntry> {
		return JSON.parse(readFileSync(authJsonPath, "utf-8"));
	}

	function flatEntryWithTwoSiblingSlots() {
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

	test("setSlot keeps sibling slots when one slot is replaced", () => {
		writeAuthJson({ openai: flatEntryWithTwoSiblingSlots() });
		const storage = AuthStorage.create(authJsonPath);

		storage.setSlot("openai", { name: "default", key: "rotated-key", source: "login" });

		const entry = readAuthJson().openai;
		expect(entry?.accounts?.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(entry?.accounts?.find((slot) => slot.name === "work")).toMatchObject({ key: "work-key" });
	});

	test("setSlot preserves the pinned slot across a write", () => {
		writeAuthJson({ openai: flatEntryWithTwoSiblingSlots() });
		const storage = AuthStorage.create(authJsonPath);

		storage.setSlot("openai", { name: "default", key: "rotated-key", source: "login" });

		expect(readAuthJson().openai).toMatchObject({ pinned: "work" });
	});

	test("removeSlot deletes only the named slot", () => {
		writeAuthJson({ openai: flatEntryWithTwoSiblingSlots() });
		const storage = AuthStorage.create(authJsonPath);

		storage.removeSlot("openai", "default");

		const entry = readAuthJson().openai;
		expect(entry?.accounts?.map((slot) => slot.name)).toEqual(["work"]);
	});

	test("removeSlot drops the provider entry once its last slot is gone", () => {
		writeAuthJson({ openai: flatEntryWithTwoSiblingSlots() });
		const storage = AuthStorage.create(authJsonPath);

		storage.removeSlot("openai", "default");
		storage.removeSlot("openai", "work");

		expect(readAuthJson().openai).toBeUndefined();
	});

	test("removeSlot clears a pin that pointed at the removed slot", () => {
		writeAuthJson({ openai: flatEntryWithTwoSiblingSlots() });
		const storage = AuthStorage.create(authJsonPath);

		storage.removeSlot("openai", "work");

		expect(readAuthJson().openai?.pinned).toBeUndefined();
	});

	test("setSlot appends a new slot to an existing pool", () => {
		writeAuthJson({ openai: flatEntryWithTwoSiblingSlots() });
		const storage = AuthStorage.create(authJsonPath);

		storage.setSlot("openai", { name: "personal", key: "personal-key", source: "login" });

		expect(readAuthJson().openai?.accounts?.map((slot) => slot.name)).toEqual(["default", "work", "personal"]);
	});

	test("setSlot promotes a pre-existing flat credential into a one-slot pool", () => {
		writeAuthJson({ openai: { type: "api_key", key: "legacy-key" } });
		const storage = AuthStorage.create(authJsonPath);

		storage.setSlot("openai", { name: "second", key: "second-key", source: "login" });

		const entry = readAuthJson().openai;
		expect(entry?.accounts?.map((slot) => slot.name)).toEqual(["default", "second"]);
		expect(entry?.accounts?.find((slot) => slot.name === "default")).toMatchObject({ key: "legacy-key" });
	});

	test("a pooled entry keeps a usable flat credential for older binaries", () => {
		writeAuthJson({ openai: { type: "api_key", key: "legacy-key" } });
		const storage = AuthStorage.create(authJsonPath);

		storage.setSlot("openai", { name: "second", key: "second-key", source: "login" });

		expect(readAuthJson().openai).toMatchObject({ type: "api_key", key: "legacy-key" });
	});

	test("set on a pooled provider appends the credential without destroying siblings", () => {
		writeAuthJson({ openai: flatEntryWithTwoSiblingSlots() });
		const storage = AuthStorage.create(authJsonPath);

		storage.set("openai", { type: "api_key", key: "rpc-login-key" });

		const entry = readAuthJson().openai;
		expect(entry?.accounts?.map((slot) => slot.name)).toEqual(["default", "work", "login-2"]);
		expect(entry?.accounts?.find((slot) => slot.name === "work")).toMatchObject({ key: "work-key" });
		expect(entry?.pinned).toBe("work");
	});

	test("set on a flat provider promotes the legacy credential instead of overwriting it", () => {
		writeAuthJson({ openai: { type: "api_key", key: "legacy-key" } });
		const storage = AuthStorage.create(authJsonPath);

		storage.set("openai", { type: "api_key", key: "second-key" });

		const entry = readAuthJson().openai;
		expect(entry?.accounts?.map((slot) => slot.name)).toEqual(["default", "login-2"]);
		expect(entry?.accounts?.find((slot) => slot.name === "default")).toMatchObject({ key: "legacy-key" });
		expect(entry?.accounts?.find((slot) => slot.name === "login-2")).toMatchObject({ key: "second-key" });
		expect(entry).toMatchObject({ type: "api_key", key: "legacy-key" });
	});

	test("set without a stored credential still writes the flat credential as-is", () => {
		writeAuthJson({});
		const storage = AuthStorage.create(authJsonPath);

		storage.set("openai", { type: "api_key", key: "first-key" });

		expect(readAuthJson().openai).toEqual({ type: "api_key", key: "first-key" });
	});

	test("reading a flat credential never rewrites auth.json", () => {
		writeAuthJson({ openai: { type: "api_key", key: "legacy-key" } });
		const before = readFileSync(authJsonPath, "utf-8");

		const storage = AuthStorage.create(authJsonPath);
		storage.get("openai");

		expect(readFileSync(authJsonPath, "utf-8")).toBe(before);
	});
});
