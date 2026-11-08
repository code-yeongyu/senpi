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
		sleep: async (ms, signal) => {
			slept.push(ms);
			signal.throwIfAborted();
		},
		stepSignal: () => new AbortController().signal,
		onChurnNotice: () => {},
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

	it("re-enters the stable-head wait after a stale post-wait retry, never the three immediate reloads (C.3)", async () => {
		const h = harness([stale, stale, stale, stale, stale, stale, ok("key-7")]);
		const source = new SealedCredentialSource(h.deps);
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("key-7");
		expect(h.requests).toHaveLength(7);
		// 3 immediate reloads, then one stable-head wait (one 5 s sleep with a stable head) before each further retry.
		expect(h.slept).toEqual([5000, 5000, 5000]);
		expect(h.reloads).toHaveLength(6);
	});

	it("keeps waiting on churn until the step aborts, and never turns churn into an error", async () => {
		const controller = new AbortController();
		const answers = Array.from({ length: 50 }, () => stale);
		const h = harness(answers);
		let sleeps = 0;
		const source = new SealedCredentialSource({
			...h.deps,
			stepSignal: () => controller.signal,
			sleep: async (ms, signal) => {
				h.slept.push(ms);
				if (++sleeps === 5) controller.abort(new Error("step aborted"));
				signal.throwIfAborted();
			},
		});
		const outcome = source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		await expect(outcome).rejects.toThrow("step aborted");
		expect(h.slept).toHaveLength(5);
		expect(h.requests).toHaveLength(3 + 1 + 4);
	});

	it("waits through a head that never settles until the step aborts", async () => {
		const controller = new AbortController();
		let n = 0;
		const h = harness([stale, stale, stale, stale]);
		const source = new SealedCredentialSource({
			...h.deps,
			readHead: async () => `h${n++}`,
			stepSignal: () => controller.signal,
			sleep: async (ms, signal) => {
				h.slept.push(ms);
				if (h.slept.length === 20) controller.abort(new Error("deadline"));
				signal.throwIfAborted();
			},
		});
		await expect(source.resolve("anthropic", "d0", ["apiKey"], SCOPE)).rejects.toThrow("deadline");
		expect(h.slept).toHaveLength(20);
		expect(h.requests).toHaveLength(4);
	});

	it("raises the config-churn notice once per step, however many wait cycles it takes", async () => {
		const h = harness([stale, stale, stale, stale, stale, stale, ok("key")]);
		const notices: unknown[] = [];
		const source = new SealedCredentialSource({ ...h.deps, onChurnNotice: (scope) => notices.push(scope) });
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("key");
		expect(h.slept).toHaveLength(3);
		expect(notices).toEqual([SCOPE]);
	});

	it("keeps the step's reload count, notice latch and latest digest across a bump retry", async () => {
		const h = harness([stale, stale, stale, stale, ok("first"), stale, ok("second")]);
		const notices: unknown[] = [];
		let bumped = false;
		const source: SealedCredentialSource = new SealedCredentialSource({
			...h.deps,
			onChurnNotice: (scope) => notices.push(scope),
			openItem: async (released, position) => {
				if (!bumped) {
					bumped = true;
					source.bumpGeneration();
				}
				return h.deps.openItem(released, position);
			},
		});
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("second");
		expect(notices).toEqual([SCOPE]);
		expect(h.requests.map((req) => req.entryDigest)).toEqual(["d0", "d1", "d2", "d3", "d4", "d4", "d5"]);
	});

	it("raises no churn notice when the immediate reloads are enough", async () => {
		const h = harness([stale, stale, stale, ok("key")]);
		const notices: unknown[] = [];
		const source = new SealedCredentialSource({ ...h.deps, onChurnNotice: (scope) => notices.push(scope) });
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("key");
		expect(notices).toEqual([]);
	});

	it("starts no release for a step that is already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("step gone"));
		const h = harness([ok("x")]);
		const source = new SealedCredentialSource({ ...h.deps, stepSignal: () => controller.signal });
		await expect(source.resolve("anthropic", "d0", ["apiKey"], SCOPE)).rejects.toThrow("step gone");
		expect(h.requests).toHaveLength(0);
	});

	it("hands the step's abort signal to the churn wait", async () => {
		const controller = new AbortController();
		const seen: AbortSignal[] = [];
		const h = harness([stale, stale, stale, stale, ok("x")]);
		const steps: unknown[] = [];
		const source = new SealedCredentialSource({
			...h.deps,
			stepSignal: (scope) => {
				steps.push(scope);
				return controller.signal;
			},
			sleep: async (_ms, signal) => {
				seen.push(signal);
			},
		});
		using lease = await source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		expect(lease.value("apiKey")).toBe("x");
		expect(steps).toEqual([SCOPE]);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((signal) => signal === controller.signal)).toBe(true);
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

	it("never returns a lease built before a bump that happened while it was resolving", async () => {
		const h = harness([ok("old"), ok("new")]);
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const source = new SealedCredentialSource({
			...h.deps,
			unsealer: {
				...h.deps.unsealer,
				async release(req) {
					calls += 1;
					if (calls === 1) await firstGate;
					return h.deps.unsealer.release(req);
				},
			},
		});
		const pending = source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		await Promise.resolve();
		source.bumpGeneration();
		releaseFirst();
		using lease = await pending;
		expect(lease.value("apiKey")).toBe("new");
		expect(h.opened[0].every((byte) => byte === 0)).toBe(true);
	});

	it("turns a second bump during the retry into a config-churn wait", async () => {
		const h = harness([ok("a"), ok("b")]);
		const source: SealedCredentialSource = new SealedCredentialSource({
			...h.deps,
			openItem: async (released, position) => {
				source.bumpGeneration();
				return h.deps.openItem(released, position);
			},
		});
		const outcome = source.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		await expect(outcome).rejects.toMatchObject({ reason: "config-churn", retryable: true });
		expect(h.opened.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
	});

	it("refuses a request that names the same field twice", async () => {
		const h = harness([ok("a", "b")]);
		const source = new SealedCredentialSource(h.deps);
		await expect(source.resolve("anthropic", "d0", ["apiKey", "apiKey"], SCOPE)).rejects.toBeInstanceOf(TypeError);
		expect(h.requests).toHaveLength(0);
	});

	it("keeps leases of one source independent of another source's bump", async () => {
		const a = new SealedCredentialSource(harness([ok("a")]).deps);
		const b = new SealedCredentialSource(harness([ok("b")]).deps);
		using leaseA = await a.resolve("anthropic", "d0", ["apiKey"], SCOPE);
		b.bumpGeneration();
		expect(leaseA.value("apiKey")).toBe("a");
	});
});
