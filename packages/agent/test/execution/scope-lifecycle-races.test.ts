// senpi#5681 (S15, #5683 review): close, the idle sweep and calls stay correct when a hold or an event races them.
import { describe, expect, it } from "vitest";
import type { DurableStore } from "../../src/durable/store.ts";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { createScopeLifecycle, ScopeUnavailableError } from "../../src/execution/scope-lifecycle.ts";

const binding = { issuer: "brain", workspace: "workspace", scope: "A", generation: 1, allowedRoots: ["/work"] };

/** A store whose next read runs `race` after reading, then returns what it read: the race lands right after a decision's read. */
async function racing() {
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const store = openMemoryStore(medium);
	let armed: (() => Promise<void>) | undefined;
	const fire = async <T>(value: T): Promise<T> => {
		const race = armed;
		armed = undefined;
		if (race !== undefined) await race();
		return value;
	};
	const wrapped: DurableStore = {
		readEpoch: () => store.readEpoch(),
		readHead: () => store.readHead(),
		claim: (expected, next) => store.claim(expected, next),
		commit: (epoch, writes, adopt) => store.commit(epoch, writes, adopt),
		mintId: () => store.mintId(),
		scanRecords: (query) => store.scanRecords(query),
		getDocument: async (key) => fire(await store.getDocument(key)),
		scanDocuments: async (prefix) => fire(await store.scanDocuments(prefix)),
		exportSnapshot: () => store.exportSnapshot(),
		importSnapshot: (epoch, snapshot) => store.importSnapshot(epoch, snapshot),
	};
	let now = 0;
	const scopes = createScopeLifecycle({
		store: wrapped,
		epoch: 1,
		admission: createAdmissionLine(),
		clock: () => now,
		idleTtlMs: 1_000,
	});
	await scopes.open(binding);
	return {
		scopes,
		arm: (race: () => Promise<void>) => {
			armed = race;
		},
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("scope lifecycle under races (#5683 review)", () => {
	it("an unforced close racing a hold is refused and the resource stays", async () => {
		const { scopes, arm } = await racing();
		arm(() => scopes.hold("A", "bash_1", "terminal"));
		expect(await scopes.close("brain", "A")).toEqual({ kind: "refused", reason: "live_resources" });
		expect(await scopes.read("A")).toMatchObject({ state: "open", resources: { bash_1: "terminal" } });
	});

	it("the idle sweep racing a hold leaves the scope open", async () => {
		const { scopes, arm, advance } = await racing();
		advance(2_000);
		arm(async () => {
			await scopes.hold("A", "bash_1", "terminal");
			advance(2_000);
		});
		expect(await scopes.sweepIdle()).toEqual([]);
		expect(await scopes.read("A")).toMatchObject({ state: "open", resources: { bash_1: "terminal" } });
	});

	it("a forced close racing a hold terminates the late resource too before closing", async () => {
		const { scopes, arm } = await racing();
		await scopes.hold("A", "r1", "execution");
		arm(() => scopes.hold("A", "late", "terminal"));
		const terminated: string[] = [];
		const terminate = async (resource: string) => {
			terminated.push(resource);
			return { reason: "cancelled" };
		};
		expect(await scopes.close("brain", "A", { force: true, terminate })).toEqual({ kind: "closed" });
		expect(terminated.sort()).toEqual(["late", "r1"]);
		expect(Object.keys((await scopes.read("A"))?.outcomes ?? {}).sort()).toEqual(["late", "r1"]);
	});

	it("a call on a closed or unknown scope is refused and never runs", async () => {
		const { scopes } = await racing();
		await scopes.close("brain", "A");
		let ran = 0;
		const run = async () => {
			ran += 1;
		};
		await expect(scopes.call("A", run)).rejects.toBeInstanceOf(ScopeUnavailableError);
		await expect(scopes.call("nowhere", run)).rejects.toBeInstanceOf(ScopeUnavailableError);
		expect(ran).toBe(0);
	});

	it("a close sent while an event's handler runs waits: the event commits, then the scope closes", async () => {
		const { scopes } = await racing();
		const held = Promise.withResolvers<void>();
		const event = scopes.lifecycle("brain", "A", "agent_end", async () => {
			await held.promise;
			return { revoked: true };
		});
		const close = scopes.close("brain", "A");
		held.resolve();
		expect(await event).toEqual({ kind: "committed", seq: 1 });
		expect(await close).toEqual({ kind: "closed" });
	});

	it("re-opening with the same binding in another key order is the same scope; a non-finite generation is refused", async () => {
		const { scopes } = await racing();
		const { allowedRoots, generation, scope, workspace, issuer } = binding;
		expect(await scopes.open({ allowedRoots, generation, scope, workspace, issuer })).toEqual({ kind: "opened" });
		await expect(scopes.open({ ...binding, scope: "B", generation: Number.NaN })).rejects.toThrow();
		expect(await scopes.read("B")).toBeUndefined();
	});
});
