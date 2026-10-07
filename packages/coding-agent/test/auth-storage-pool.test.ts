import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";

const FUTURE = 4_102_444_800_000;

let dir: string;
let authPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "auth-pool-"));
	authPath = join(dir, "auth.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeAuthFile(data: Record<string, unknown>): string {
	const content = JSON.stringify(data, null, 2);
	writeFileSync(authPath, content, { encoding: "utf-8", mode: 0o600 });
	return content;
}

function pooledOAuthEntry(): PooledCredential {
	return {
		type: "oauth",
		access: "flat-access",
		refresh: "flat-refresh",
		expires: FUTURE,
		accounts: [
			{ name: "default", access: "flat-access", refresh: "flat-refresh", expires: FUTURE, source: "login" },
			{ name: "work", access: "work-access", refresh: "work-refresh", expires: FUTURE, source: "login" },
		],
		pinned: "work",
	};
}

describe("auth.json accepts and preserves credential slots", () => {
	test("a flat api_key and oauth file reads unchanged and is not rewritten", async () => {
		const original = writeAuthFile({
			openai: { type: "api_key", key: "sk-flat" },
			anthropic: { type: "oauth", access: "a", refresh: "r", expires: FUTURE },
		});

		const store = AuthStorage.create(authPath);
		expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-flat" });
		expect(await store.read("anthropic")).toMatchObject({ type: "oauth", access: "a" });
		expect(readFileSync(authPath, "utf-8")).toBe(original);
	});

	test("a pooled entry reads with accounts and pin preserved, without a rewrite", async () => {
		const original = writeAuthFile({ pooled: pooledOAuthEntry() });

		const store = AuthStorage.create(authPath);
		const credential = await store.read("pooled");
		expect(credential).toMatchObject({ type: "oauth", access: "flat-access", pinned: "work" });
		const pooled = credential as PooledCredential;
		expect(pooled.accounts?.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(readFileSync(authPath, "utf-8")).toBe(original);
	});

	test("ReadOnlyAuthStorage accepts a pooled entry through its validator", async () => {
		writeAuthFile({ pooled: pooledOAuthEntry() });

		const store = new ReadOnlyAuthStorage(authPath);
		const credential = (await store.read("pooled")) as PooledCredential;
		expect(credential.accounts?.length).toBe(2);
		expect(credential.pinned).toBe("work");
	});

	test("a modify that returns the current entry preserves pool bytes", async () => {
		const original = writeAuthFile({ pooled: pooledOAuthEntry() });

		const store = AuthStorage.create(authPath);
		await store.modify("pooled", async (current) => current);
		expect(readFileSync(authPath, "utf-8")).toBe(original);
	});

	test("a pooled write keeps auth.json at mode 0600", async () => {
		const store = AuthStorage.create(authPath);
		await store.modify("pooled", async () => pooledOAuthEntry());

		expect(statSync(authPath).mode & 0o777).toBe(0o600);
		const reread = (await store.read("pooled")) as PooledCredential;
		expect(reread.accounts?.map((slot) => slot.name)).toEqual(["default", "work"]);
	});

	test("a pooled oauth entry without its flat projection is rejected by the read-only validator", async () => {
		writeAuthFile({
			broken: {
				type: "oauth",
				accounts: [{ name: "only", access: "x", refresh: "y", expires: FUTURE, source: "login" }],
			},
		});

		const store = new ReadOnlyAuthStorage(authPath);
		await expect(store.read("broken")).rejects.toThrow('Invalid auth.json credential for provider "broken"');
	});
});
