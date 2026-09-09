import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("AuthStorage concurrent slot mutations", () => {
	const tempDir = join(tmpdir(), `pi-test-auth-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const authJsonPath = join(tempDir, "auth.json");

	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(
			authJsonPath,
			JSON.stringify({
				openai: {
					type: "api_key",
					key: "primary-key",
					accounts: [
						{ name: "default", key: "primary-key", source: "login" },
						{ name: "work", key: "work-key", source: "login" },
					],
				},
			}),
		);
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function slotNames(): string[] {
		const entry = JSON.parse(readFileSync(authJsonPath, "utf-8")).openai;
		return (entry?.accounts ?? []).map((slot: { name: string }) => slot.name);
	}

	test("concurrent setSlot writes on different slots both land", () => {
		const a = AuthStorage.create(authJsonPath);
		const b = AuthStorage.create(authJsonPath);

		a.setSlot("openai", { name: "alpha", key: "a", source: "login" });
		b.setSlot("openai", { name: "beta", key: "b", source: "login" });

		const names = slotNames();
		expect(names).toContain("alpha");
		expect(names).toContain("beta");
		expect(names).toContain("default");
		expect(names).toContain("work");
	});

	test("a login racing a slot write loses neither slot", () => {
		const a = AuthStorage.create(authJsonPath);
		const b = AuthStorage.create(authJsonPath);

		a.setSlot("openai", { name: "alpha", key: "a", source: "login" });
		b.set("openai", { type: "api_key", key: "raced-login" });

		const entry = JSON.parse(readFileSync(authJsonPath, "utf-8")).openai;
		const names = slotNames();
		expect(names).toContain("alpha");
		expect(names).toContain("login-2");
		expect(entry.accounts.find((slot: { name: string }) => slot.name === "login-2")).toMatchObject({
			key: "raced-login",
		});
	});

	test("a removeSlot racing a refresh-shaped set keeps the survivor", () => {
		const a = AuthStorage.create(authJsonPath);
		const b = AuthStorage.create(authJsonPath);

		a.set("openai", { type: "api_key", key: "refresh-raced" });
		b.removeSlot("openai", "work");

		const names = slotNames();
		expect(names).toContain("default");
		expect(names).not.toContain("work");
		expect(names).toContain("login-2");
	});

	test("deferred interleaving: a settle between read and write cannot drop a sibling", async () => {
		const a = AuthStorage.create(authJsonPath);
		const gate = deferred<void>();
		const held = a.modify("openai", async (current) => {
			await gate.promise;
			return current;
		});
		const raced = (async () => {
			gate.resolve();
			await held;
			a.setSlot("openai", { name: "gamma", key: "g", source: "login" });
		})();
		await raced;
		expect(slotNames()).toContain("gamma");
		expect(slotNames()).toContain("work");
	});
});
