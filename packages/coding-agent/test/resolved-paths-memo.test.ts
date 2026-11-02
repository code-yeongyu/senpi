import { describe, expect, it } from "vitest";
import { clearResolvedPathsMemo, memoizeResolvedPaths, resolvedPathsMemoKey } from "../src/core/resolved-paths-memo.ts";

const baseInput = {
	agentDir: "/agent",
	cwd: "/cwd",
	projectTrusted: true,
	globalSettings: { packages: ["a"], theme: "dark" },
	projectSettings: { packages: ["b"] },
	additionalExtensionPaths: ["./x.ts"],
};

describe("resolvedPathsMemoKey", () => {
	it("is stable across property order and ignores undefined", () => {
		const reordered = {
			additionalExtensionPaths: ["./x.ts"],
			projectSettings: { packages: ["b"] },
			globalSettings: { theme: "dark", packages: ["a"], extra: undefined },
			cwd: "/cwd",
			projectTrusted: true,
			agentDir: "/agent",
		};
		expect(resolvedPathsMemoKey(reordered)).toBe(resolvedPathsMemoKey(baseInput));
	});

	it("changes when any input changes", () => {
		const key = resolvedPathsMemoKey(baseInput);
		expect(resolvedPathsMemoKey({ ...baseInput, cwd: "/other" })).not.toBe(key);
		expect(resolvedPathsMemoKey({ ...baseInput, agentDir: "/other" })).not.toBe(key);
		// senpi#2371: resolution reads the trust state, so trust alone must split the key.
		expect(resolvedPathsMemoKey({ ...baseInput, projectTrusted: false })).not.toBe(key);
		expect(resolvedPathsMemoKey({ ...baseInput, globalSettings: { packages: ["a", "c"] } })).not.toBe(key);
		expect(resolvedPathsMemoKey({ ...baseInput, projectSettings: {} })).not.toBe(key);
		expect(resolvedPathsMemoKey({ ...baseInput, additionalExtensionPaths: [] })).not.toBe(key);
	});
});

describe("memoizeResolvedPaths", () => {
	it("computes once per key and hands concurrent callers the same promise", async () => {
		clearResolvedPathsMemo();
		let computes = 0;
		let release!: (value: string) => void;
		const compute = () =>
			new Promise<string>((resolve) => {
				computes += 1;
				release = resolve;
			});

		const first = memoizeResolvedPaths("k", compute);
		const second = memoizeResolvedPaths("k", compute);
		expect(second).toBe(first);
		expect(computes).toBe(1);

		release("resolved");
		await expect(first).resolves.toBe("resolved");
		await expect(memoizeResolvedPaths("k", compute)).resolves.toBe("resolved");
		expect(computes).toBe(1);
	});

	it("does not keep a failed computation", async () => {
		clearResolvedPathsMemo();
		let computes = 0;
		const failing = () => {
			computes += 1;
			return Promise.reject(new Error("boom"));
		};
		await expect(memoizeResolvedPaths("k", failing)).rejects.toThrow("boom");
		await expect(memoizeResolvedPaths("k", failing)).rejects.toThrow("boom");
		expect(computes).toBe(2);
	});

	it("keeps keys apart", async () => {
		clearResolvedPathsMemo();
		await expect(memoizeResolvedPaths("a", () => Promise.resolve(1))).resolves.toBe(1);
		await expect(memoizeResolvedPaths("b", () => Promise.resolve(2))).resolves.toBe(2);
		await expect(memoizeResolvedPaths("a", () => Promise.resolve(99))).resolves.toBe(1);
	});
});
