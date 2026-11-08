import { describe, expect, it } from "vitest";
import type {
	EpochLeaseToken,
	ReleaseRequest,
	ReleaseResult,
	SecretField,
	Unsealer,
} from "../../src/core/egress/credentials.ts";
import { CredentialWait, SecretNotLeased } from "../../src/core/egress/credentials.ts";
import type { HpkeWrap } from "../../src/core/egress/sealed-format.ts";
import { HPKE_SUITE } from "../../src/core/egress/sealed-format.ts";
import { SealedCredentialSource, type SealedSourceDeps } from "../../src/core/egress/sealed-source.ts";

const SCOPE = { sessionId: "s1", callId: "c1", purpose: "model-call" } as const;
const HEAD = { version: 7, objectHash: "h7" };

function item(value: string): HpkeWrap {
	return { suite: HPKE_SUITE, enc: "e", ct: value };
}

interface Harness {
	deps: SealedSourceDeps;
	requests: ReleaseRequest[];
	reloads: string[];
	slept: number[];
	opened: Uint8Array[];
}

function harness(answers: ReleaseResult[], heads: string[] = []): Harness {
	const requests: ReleaseRequest[] = [];
	const reloads: string[] = [];
	const slept: number[] = [];
	const opened: Uint8Array[] = [];
	let digest = 0;
	const unsealer: Unsealer = {
		async release(req) {
			requests.push(req);
			const next = answers.shift();
			if (!next) throw new Error("unexpected release");
			return next;
		},
		async releaseConfig() {
			throw new Error("not used");
		},
	};
	const lease: EpochLeaseToken = { token: "lease" };
	const deps: SealedSourceDeps = {
		accountId: "acct",
		unsealer,
		lease: async () => lease,
		recipientPk: new Uint8Array([4, 1, 2]),
		reloadEntryDigest: async (providerId) => {
			digest += 1;
			const next = `d${digest}`;
			reloads.push(`${providerId}:${next}`);
			return next;
		},
		readHead: async () => heads.shift() ?? "stable",
		sleep: async (ms) => {
			slept.push(ms);
		},
		openItem: async (released) => {
			const bytes = new TextEncoder().encode(released.ct);
			opened.push(bytes);
			return bytes;
		},
	};
	return { deps, requests, reloads, slept, opened };
}

const ok = (...values: string[]): ReleaseResult => ({ ok: true, items: values.map(item), head: HEAD });
const stale: ReleaseResult = { ok: false, code: "stale_snapshot", head: HEAD };

describe("SealedCredentialSource.resolve", () => {
	it("releases the requested fields at the given entry and leases their values", async () => {
		const h = harness([ok("key-1", "hdr-1")]);
		const source = new SealedCredentialSource(h.deps);
		const fields: SecretField[] = ["apiKey", "header:x-api-key"];
		using lease = await source.resolve("anthropic", "d0", fields, SCOPE);
		expect(lease.value("apiKey")).toBe("key-1");
		expect(lease.value("header:x-api-key")).toBe("hdr-1");
		expect(h.requests).toHaveLength(1);
		expect(h.requests[0]).toMatchObject({
			accountId: "acct",
			providerId: "anthropic",
			entryDigest: "d0",
			fields,
			lease: { token: "lease" },
			scope: SCOPE,
		});
	});

	it("hands the opener the exact lease the release was made under, per item and position", async () => {
		const h = harness([ok("key-1", "hdr-1")]);
		const positions: unknown[] = [];
		let issued = 0;
		const source = new SealedCredentialSource({
			...h.deps,
			lease: async () => ({ token: `lease-${++issued}` }),
			openItem: async (released, position) => {
				positions.push(position);
				return new TextEncoder().encode(released.ct);
			},
		});
		using lease = await source.resolve("anthropic", "d0", ["apiKey", "header:x"], SCOPE);
		expect(lease.value("header:x")).toBe("hdr-1");
		expect(h.requests[0].lease).toEqual({ token: "lease-1" });
		expect(positions).toEqual([
			{
				accountId: "acct",
				providerId: "anthropic",
				entryDigest: "d0",
				field: "apiKey",
				lease: { token: "lease-1" },
			},
			{
				accountId: "acct",
				providerId: "anthropic",
				entryDigest: "d0",
				field: "header:x",
				lease: { token: "lease-1" },
			},
		]);
		expect(issued).toBe(1);
	});

	it("reloads and retries on stale_snapshot, with the reloaded entry digest", async () => {
		const h = harness([stale, ok("key-2")]);
		const source = new SealedCredentialSource(h.deps);
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("key-2");
		expect(h.reloads).toEqual(["anthropic:d1"]);
		expect(h.requests.map((req) => req.entryDigest)).toEqual(["d0", "d1"]);
		expect(h.slept).toEqual([]);
	});

	it("allows three reloads in one step without waiting", async () => {
		const h = harness([stale, stale, stale, ok("key-4")]);
		const source = new SealedCredentialSource(h.deps);
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("key-4");
		expect(h.reloads).toHaveLength(3);
		expect(h.slept).toEqual([]);
	});

	it("treats a fourth stale_snapshot as config-churn: waits for a 5 s stable head, then retries once", async () => {
		const h = harness([stale, stale, stale, stale, ok("key-5")], ["h-a", "h-b", "h-b", "h-b"]);
		const source = new SealedCredentialSource(h.deps);
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("key-5");
		expect(h.slept.every((ms) => ms === 5000)).toBe(true);
		expect(h.slept.length).toBeGreaterThanOrEqual(2);
		expect(h.requests).toHaveLength(5);
	});

	it("never errors on churn: still stale after the stable-head retry is a config-churn wait", async () => {
		const h = harness([stale, stale, stale, stale, stale]);
		const source = new SealedCredentialSource(h.deps);
		const outcome = source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		await expect(outcome).rejects.toBeInstanceOf(CredentialWait);
		await expect(outcome).rejects.toMatchObject({ reason: "config-churn" });
		expect(h.requests).toHaveLength(5);
	});

	it("resets the reload budget per step", async () => {
		const h = harness([stale, stale, stale, ok("a"), stale, stale, stale, ok("b")]);
		const source = new SealedCredentialSource(h.deps);
		(await source.resolve("anthropic", "d0", ["apiKey"], SCOPE))[Symbol.dispose]();
		using second = await source.resolve("anthropic", "d3", ["apiKey"], { ...SCOPE, callId: "c2" });
		expect(second.value("apiKey")).toBe("b");
		expect(h.slept).toEqual([]);
	});

	it.each([
		["unavailable", true],
		["epoch_mismatch", true],
		["wrap_missing", true],
		["owner_revoked", false],
		["denied", false],
	] as const)("maps %s to a typed refusal (wait: %s), never a plaintext fallback", async (code, wait) => {
		const h = harness([{ ok: false, code }]);
		const source = new SealedCredentialSource(h.deps);
		const outcome = source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		await expect(outcome).rejects.toBeInstanceOf(CredentialWait);
		await expect(outcome).rejects.toMatchObject({ reason: code, retryable: wait });
	});
});

describe("SecretLease", () => {
	it("refuses a field it did not lease", async () => {
		const h = harness([ok("key-1")]);
		using lease = await new SealedCredentialSource(h.deps).resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(() => lease.value("header:x-api-key")).toThrow(SecretNotLeased);
	});

	it("zeroes its byte buffers and refuses reads after dispose", async () => {
		const h = harness([ok("key-1")]);
		const lease = await new SealedCredentialSource(h.deps).resolve("anthropic", "d0", ["apiKey"], SCOPE);
		lease[Symbol.dispose]();
		expect(h.opened[0].every((byte) => byte === 0)).toBe(true);
		expect(() => lease.value("apiKey")).toThrow(SecretNotLeased);
	});

	it("never prints its values", async () => {
		const h = harness([ok("key-1")]);
		using lease = await new SealedCredentialSource(h.deps).resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(JSON.stringify(lease)).toBe('"<redacted>"');
		expect(String(lease)).toBe("<redacted>");
	});

	it("is disposed by a generation bump on its source", async () => {
		const h = harness([ok("a"), ok("b")]);
		const source = new SealedCredentialSource(h.deps);
		const first = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		const second = await source.resolve("openai", "d9", ["apiKey"], SCOPE);
		source.bumpGeneration();
		expect(() => first.value("apiKey")).toThrow(SecretNotLeased);
		expect(() => second.value("apiKey")).toThrow(SecretNotLeased);
	});

	it("keeps leases of one source independent of another source's bump", async () => {
		const a = new SealedCredentialSource(harness([ok("a")]).deps);
		const b = new SealedCredentialSource(harness([ok("b")]).deps);
		using leaseA = await a.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		b.bumpGeneration();
		expect(leaseA.value("apiKey")).toBe("a");
	});
});
