import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { migrateAnthropicOAuthToSubscription } from "../../../src/core/anthropic-oauth-migration.ts";

type Store = Record<string, Credential>;

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function credentialStrings(value: unknown, into: Set<string>): Set<string> {
	if (Array.isArray(value)) for (const item of value) credentialStrings(item, into);
	else if (typeof value === "object" && value !== null) {
		for (const [field, inner] of Object.entries(value)) {
			if ((field === "refresh" || field === "key") && typeof inner === "string") into.add(inner);
			else credentialStrings(inner, into);
		}
	}
	return into;
}

function randomStore(next: () => number): Store {
	const pick = <T>(options: readonly T[]): T => options[Math.floor(next() * options.length)] as T;
	const token = () => `t${Math.floor(next() * 6)}`;
	const grant = (name?: string) => ({
		...(name ? { name } : {}),
		access: `a-${token()}`,
		refresh: token(),
		expires: 1,
	});
	const slot = (index: number): unknown =>
		pick([
			() => grant(`s${index}`),
			() => ({ name: `k${index}`, key: `key-${token()}` }),
			() => ({ name: `bad${index}` }),
			() => null,
			() => ({ name: `s${index}`, access: "x", refresh: token(), expires: "soon" }),
		])();
	const accounts = pick([
		() => undefined,
		() => ({ not: "a list" }),
		() => Array.from({ length: Math.floor(next() * 4) }, (_, index) => slot(index)),
	])();
	const flat = pick([() => grant(), () => ({ access: "x" }), () => ({})])();
	const anthropic = {
		type: "oauth",
		...flat,
		...(accounts === undefined ? {} : { accounts }),
		pinned: pick(["s0", "k1", undefined]),
	};
	const subscription = pick([
		() => undefined,
		() => "not an object",
		() => ({ type: "oauth", access: "m", refresh: "m", expires: 1 }),
		() => ({
			type: "oauth",
			access: "m",
			refresh: "m",
			expires: 1,
			accounts: [{ name: "imported-anthropic", ...grant() }],
		}),
		() => ({ type: "oauth", access: "m", refresh: "m", expires: 1, accounts: [null] }),
		() => ({ type: "oauth", access: "m", refresh: "m", expires: 1, accounts: { bad: true } }),
	])();
	return {
		openai: { type: "api_key", key: "sk-openai" },
		anthropic: anthropic as unknown as Credential,
		...(subscription === undefined ? {} : { "anthropic-subscription": subscription as unknown as Credential }),
	};
}

describe("the #3259 migration never loses a credential (property)", () => {
	it("keeps every refresh token and API key across 500 odd stores and always settles", () => {
		const next = rng(3259);
		for (let run = 0; run < 500; run++) {
			const input = randomStore(next);
			const before = credentialStrings(input, new Set());
			let current = input;
			let passes = 0;
			for (; passes < 4; passes++) {
				const result = migrateAnthropicOAuthToSubscription(current);
				if (result.skipped !== undefined) expect(result.data).toBe(current);
				if (!result.migrated) break;
				current = result.data;
			}
			expect(passes, `run ${run} did not settle`).toBeLessThan(4);
			expect(current.openai).toEqual({ type: "api_key", key: "sk-openai" });
			const after = credentialStrings(current, new Set());
			for (const value of before) expect(after.has(value), `run ${run} lost ${value}`).toBe(true);
		}
	});
});
