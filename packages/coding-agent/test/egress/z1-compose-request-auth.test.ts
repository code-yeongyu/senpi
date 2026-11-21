import { describe, expect, it } from "vitest";
import { composeRequestAuth, type SecretField } from "../../src/core/egress/compose-request-auth.ts";

function mapResolver(values: Readonly<Record<string, string>>) {
	const asked: SecretField[] = [];
	const resolve = (field: SecretField): string => {
		asked.push(field);
		const value = values[field];
		if (value === undefined) throw new Error(`not leased: ${field}`);
		return value;
	};
	return { asked, resolve };
}

describe("composeRequestAuth over an injected field resolver", () => {
	it("asks for each configured header by field, in declaration order, and composes Authorization last", async () => {
		const resolver = mapResolver({ "header:X-A": "a", "header:x-api-key": "hk" });
		const auth = await composeRequestAuth(
			{ apiKey: "sk", headers: { "X-Base": "base" } },
			{ headerNames: ["X-A", "x-api-key"], authHeader: true },
			resolver.resolve,
		);
		expect(resolver.asked).toEqual(["header:X-A", "header:x-api-key"]);
		expect(auth).toStrictEqual({
			apiKey: "sk",
			headers: { "X-Base": "base", "X-A": "a", "x-api-key": "hk", Authorization: "Bearer sk" },
		});
		expect(Object.keys(auth?.headers ?? {})).toEqual(["X-Base", "X-A", "x-api-key", "Authorization"]);
	});

	it("keeps `headers: undefined` when nothing is configured and no base headers exist", async () => {
		const resolver = mapResolver({});
		expect(
			await composeRequestAuth({ apiKey: "sk" }, { headerNames: [], authHeader: false }, resolver.resolve),
		).toStrictEqual({ apiKey: "sk", headers: undefined });
		expect(resolver.asked).toEqual([]);
	});

	it("is no auth without a base or a credential header, and auth with a credential header alone", async () => {
		const plain = mapResolver({ "header:X-Org": "o" });
		expect(await composeRequestAuth(undefined, { headerNames: ["X-Org"], authHeader: false }, plain.resolve)).toBe(
			undefined,
		);
		const credential = mapResolver({ "header:x-api-key": "hk" });
		expect(
			await composeRequestAuth(undefined, { headerNames: ["x-api-key"], authHeader: false }, credential.resolve),
		).toStrictEqual({ headers: { "x-api-key": "hk" } });
	});

	it("refuses authHeader without a key with the shared message", async () => {
		const resolver = mapResolver({ "header:x-api-key": "hk" });
		await expect(
			composeRequestAuth(undefined, { headerNames: ["x-api-key"], authHeader: true }, resolver.resolve),
		).rejects.toThrow(/^authHeader requires a resolved API key$/);
	});

	it("stops at the first field the resolver refuses and asks for nothing after it", async () => {
		const resolver = mapResolver({ "header:X-Second": "s" });
		await expect(
			composeRequestAuth(
				{ apiKey: "sk" },
				{ headerNames: ["X-First", "X-Second"], authHeader: false },
				resolver.resolve,
			),
		).rejects.toThrow(/^not leased: header:X-First$/);
		expect(resolver.asked).toEqual(["header:X-First"]);
	});

	it("awaits an asynchronous resolver one field at a time", async () => {
		const order: string[] = [];
		const auth = await composeRequestAuth(
			{ apiKey: "sk" },
			{ headerNames: ["X-1", "X-2"], authHeader: false },
			async (field) => {
				order.push(`start ${field}`);
				await Promise.resolve();
				order.push(`end ${field}`);
				return field;
			},
		);
		expect(order).toEqual(["start header:X-1", "end header:X-1", "start header:X-2", "end header:X-2"]);
		expect(auth?.headers).toStrictEqual({ "X-1": "header:X-1", "X-2": "header:X-2" });
	});
});
