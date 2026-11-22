import { afterEach, describe, expect, test } from "vitest";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";
import { type ConfigValueObserver, resolveConfigValue } from "../src/index.ts";

type Seen = readonly [field: string, providerId: string, value: string, cwd: string];

function recorder(): { readonly observer: ConfigValueObserver; readonly seen: Seen[] } {
	const seen: Seen[] = [];
	return { observer: (field, providerId, value, cwd) => seen.push([field, providerId, value, cwd]), seen };
}

describe("resolveConfigValue observation (custody CK18)", () => {
	afterEach(() => clearConfigValueCache());

	test("hands each resolved value to the observer with the field, provider and cwd", async () => {
		const { observer, seen } = recorder();
		const env = { CK18_KEY: "sk-observed" };
		const observation = { observer, providerId: "acme", field: "apiKey", cwd: "/work/a" };

		expect(await resolveConfigValue("$CK18_KEY", env, undefined, observation)).toBe("sk-observed");
		expect(await resolveConfigValue("!printf from-command", env, undefined, observation)).toBe("from-command");
		expect(await resolveConfigValue("literal-key", env, undefined, observation)).toBe("literal-key");

		expect(seen).toEqual([
			["apiKey", "acme", "sk-observed", "/work/a"],
			["apiKey", "acme", "from-command", "/work/a"],
			["apiKey", "acme", "literal-key", "/work/a"],
		]);
	});

	test("does not observe a value that did not resolve", async () => {
		const { observer, seen } = recorder();
		const resolved = await resolveConfigValue("!exit 3", {}, undefined, {
			observer,
			providerId: "acme",
			field: "apiKey",
			cwd: "/work/a",
		});
		expect(resolved).toBeUndefined();
		expect(seen).toEqual([]);
	});

	test("without an observation it returns the unobserved promise itself, with no extra settle step", async () => {
		const env = { CK18_KEY: "sk-plain" };
		const order: string[] = [];
		const plain = resolveConfigValue("$CK18_KEY", env).then(() => order.push("plain"));
		const marker = Promise.resolve().then(() => order.push("marker"));
		await Promise.all([plain, marker]);
		expect(order).toEqual(["plain", "marker"]);
	});
});
