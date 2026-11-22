import { describe, expect, test } from "vitest";
import { slotKind, slotsOfOwnKind, unusedSlotKinds } from "../src/auth/pool/kinds.ts";
import { appendLoginSlot, type Credential, listSlots, type PooledCredential } from "../src/auth/pool/slots.ts";

const oauth: Credential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 };
const apiKey: Credential = { type: "api_key", key: "new-key" };

// senpi#3448 / omo-desktop-app#2793: a pool holds one kind of credential. A login of the other kind
// used to be appended as a slot the pool could never project, so the saved key was never used.
describe("a login of another kind replaces the credential (senpi#3448)", () => {
	test("an API key saved over an OAuth login becomes the credential", () => {
		expect(appendLoginSlot(oauth, apiKey)).toEqual(apiKey);
	});

	test("an OAuth login over an API key becomes the credential", () => {
		expect(appendLoginSlot(apiKey, oauth)).toEqual(oauth);
	});

	test("an API key over an OAuth pool replaces the whole pool", () => {
		const pool: PooledCredential = {
			...oauth,
			accounts: [
				{ name: "default", source: "login", access: "a1", refresh: "r1", expires: 1 },
				{ name: "work", source: "login", access: "a2", refresh: "r2", expires: 2 },
			],
			pinned: "work",
		};
		expect(appendLoginSlot(pool, apiKey)).toEqual(apiKey);
	});

	test("a login of the same kind still joins the pool", () => {
		const next = appendLoginSlot({ type: "api_key", key: "first" }, { type: "api_key", key: "second" });
		expect(listSlots(next).map((slot) => slot.key)).toEqual(["first", "second"]);
	});
});

describe("which slots a credential cannot use (senpi#3448)", () => {
	test("a slot is classified only by its own material", () => {
		expect(slotKind({ access: "a", refresh: "r" })).toBe("oauth");
		expect(slotKind({ key: "k" })).toBe("api_key");
		expect(slotKind({})).toBeUndefined();
	});

	test("names the other kind's slots of a mixed pool built by older releases", () => {
		const mixed: PooledCredential = {
			...oauth,
			accounts: [
				{ name: "default", source: "login", access: "old-access", refresh: "old-refresh", expires: 1 },
				{ name: "login-2", source: "login", key: "new-key" },
			],
		};
		expect(unusedSlotKinds(mixed)).toEqual(["api_key"]);
	});

	test("a single-kind pool, a flat credential, a malformed list or an unclassified slot reports nothing", () => {
		expect(unusedSlotKinds(oauth)).toEqual([]);
		expect(
			unusedSlotKinds({
				type: "api_key",
				key: "a",
				accounts: [
					{ name: "default", key: "a" },
					{ name: "work", key: "b" },
				],
			}),
		).toEqual([]);
		expect(unusedSlotKinds({ ...oauth, accounts: { bad: true } } as unknown as PooledCredential)).toEqual([]);
		expect(unusedSlotKinds({ ...apiKey, accounts: [{ name: "default", key: "new-key" }, { name: "meta" }] })).toEqual(
			[],
		);
		expect(unusedSlotKinds(undefined)).toEqual([]);
	});
});

describe("the slots a credential can use (senpi#3486)", () => {
	test("a mixed pool offers only its own kind; unclassified slots stay as before", () => {
		const mixed: PooledCredential = {
			...oauth,
			accounts: [
				{ name: "default", source: "login", access: "a", refresh: "r", expires: 1 },
				{ name: "login-2", source: "login", key: "k" },
				{ name: "meta" },
			],
		};
		expect(slotsOfOwnKind(mixed).map((slot) => slot.name)).toEqual(["default", "meta"]);
		expect(slotsOfOwnKind(apiKey).map((slot) => slot.name)).toEqual(["default"]);
	});
});
