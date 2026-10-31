import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { rendezvousOrder } from "@earendil-works/pi-ai/auth/pool/select";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getCredentialAccounts } from "../src/core/credential-accounts.ts";
import {
	listRotationSlots,
	sha256SlotHasher,
	streamWithCredentialRotation,
} from "../src/core/credential-pool/rotation-stream.ts";
import { type CredentialSlotState, CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";
import { subscribeProviderAccountEvents } from "../src/core/extensions/builtin/anthropic-subscription/account-events.ts";
import { FILE_STORAGE_LOCK_OPTIONS } from "../src/core/lockfile-policy.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const NOW = 1_756_000_000_000;

let dir: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rotation-stream-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function pooled(): PooledCredential {
	return {
		type: "api_key",
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" },
			{ name: "work", key: "key-work", source: "login" },
		],
	};
}

function partialMessage(errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: errorMessage === undefined ? "stop" : "error",
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	};
}

function startEvent(): AssistantMessageEvent {
	return { type: "start", partial: partialMessage() };
}

function textEvent(text: string): AssistantMessageEvent {
	return {
		type: "text_delta",
		contentIndex: 0,
		delta: text,
		partial: partialMessage(),
	};
}

function errorEvent(message: string): AssistantMessageEvent {
	return { type: "error", reason: "error", error: partialMessage(message) };
}

async function* stream(...items: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
	for (const item of items) yield item;
}

async function collect(source: AsyncGenerator<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const seen: AssistantMessageEvent[] = [];
	for await (const event of source) seen.push(event);
	return seen;
}

/**
 * Consumes a runtime event stream to its terminal event and then CLOSES it.
 *
 * The stream reports completion at the terminal event, but the credential
 * rotation generator behind `ModelRuntime.stream` still has to run its final
 * pool-state persistence write after yielding that event. Removing the
 * runtime's temp dir while that write is in flight fails with ENOTEMPTY
 * (issue #1457), so teardown must not race it: breaking out of the loop
 * invokes the lazy stream's cancellation handler, which awaits the inner
 * generator's completion before returning.
 */
async function collectClosedRuntimeEvents(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return events;
}

describe("credential rotation over a pooled provider", () => {
	test("runtime admission runs an expired stored probe once", async () => {
		const faux = fauxProvider();
		const credentials = AuthStorage.inMemory();
		await credentials.modify("faux", async () => pooled());
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			agentDir: dir,
			allowModelNetwork: false,
		});
		await runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
		const pool = (await (runtime as any).loadCredentialPool()).repository as CredentialSlotRepository;
		await pool.mutateSlotState("faux", "stored", "default", () => ({
			blockedUntil: NOW - 1,
			blockReason: "rate_limit",
		}));
		await pool.mutateSlotState("faux", "stored", "work", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
		}));
		faux.setResponses([fauxAssistantMessage("probe")]);
		const events = await collectClosedRuntimeEvents(
			runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "runtime-probe" }),
		);
		expect(events.some((event) => event.type === "done")).toBe(true);
		expect(faux.getCallLog()).toHaveLength(1);
	});

	test("runtime admits policy-only credential slots", async () => {
		const dir = mkdtempSync(join(tmpdir(), "policy-only-runtime-"));
		const faux = fauxProvider({ provider: "policy-only" });
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({
				providers: {
					"policy-only": { credentials: { slots: { one: { value: "key-one" }, two: { value: "key-two" } } } },
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: join(dir, "models.json"),
			agentDir: dir,
			allowModelNetwork: false,
		});
		await runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: ["policy-only"] });
		faux.setResponses([fauxAssistantMessage("policy-ok")]);
		const events = await collectClosedRuntimeEvents(runtime.stream(faux.getModel(), { messages: [], tools: [] }));
		expect(events.some((event) => event.type === "done")).toBe(true);
		expect(faux.getCallLog()).toHaveLength(1);
		rmSync(dir, { recursive: true, force: true });
	});

	test("a pool holding a poisoned sentinel slot never attempts it and serves the healthy account", async () => {
		const sentinelDir = mkdtempSync(join(tmpdir(), "sentinel-pool-rotation-"));
		const sentinelRepository = new CredentialSlotRepository(join(sentinelDir, "credential-pool-state.json"));
		// The pool exactly as the shipped double-store bug left it: real accounts
		// plus a generated `login-2` slot carrying the provider-managed sentinel
		// in place of tokens.
		const poisoned: PooledCredential = {
			type: "oauth",
			access: "key-default",
			refresh: "r-default",
			pinned: "login-2",
			expires: NOW + 3_600_000,
			accounts: [
				{ name: "default", access: "key-default", refresh: "r-default", expires: NOW + 3_600_000, source: "login" },
				{
					name: "login-2",
					access: "claude-sdk-oauth-managed",
					refresh: "claude-sdk-oauth-managed",
					expires: NOW + 3_600_000,
					source: "login",
				},
				{ name: "work", access: "key-work", refresh: "r-work", expires: NOW + 3_600_000, source: "login" },
			],
		};
		// The store parse heals the pool before rotation ever lists it.
		const store = AuthStorage.inMemory({ "anthropic-subscription": poisoned });
		const healed = (await store.read("anthropic-subscription")) as PooledCredential;
		const sources = {
			providerId: "anthropic-subscription",
			credential: healed,
			env: () => undefined,
			repository: sentinelRepository,
			now: () => NOW,
		};
		const slots = await listRotationSlots(sources);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);

		const attempted: string[] = [];
		const events = await collect(
			streamWithCredentialRotation({
				sources,
				affinityKey: "sentinel-pool",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("healthy-account-ok"));
				},
			}),
		);
		expect(attempted).toHaveLength(1);
		expect(attempted[0]).not.toBe("login-2");
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		rmSync(sentinelDir, { recursive: true, force: true });
	});

	test("runtime admits one canonical env slot plus one policy slot", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "combined-runtime-"));
		const faux = fauxProvider({ provider: "anthropic" });
		writeFileSync(
			join(configDir, "models.json"),
			JSON.stringify({ providers: { anthropic: { credentials: { slots: { broker: { value: "key-policy" } } } } } }),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: join(configDir, "models.json"),
			agentDir: configDir,
			allowModelNetwork: false,
		});
		await runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: ["anthropic"] });
		faux.setResponses([
			() => {
				throw new Error("401 unauthorized");
			},
			fauxAssistantMessage("combined-ok"),
		]);
		const events = await collectClosedRuntimeEvents(
			runtime.stream(
				faux.getModel(),
				{ messages: [], tools: [] },
				{
					env: { ANTHROPIC_API_KEY: "key-env" },
				},
			),
		);
		expect(events.some((event) => event.type === "done")).toBe(true);
		expect(faux.getCallLog()).toHaveLength(2);
		expect(
			faux
				.getCallLog()
				.map((call) => call.options?.apiKey)
				.sort(),
		).toEqual(["key-env", "key-policy"]);
		rmSync(configDir, { recursive: true, force: true });
	});

	test("ordinary streamSimple requests rotate before output", async () => {
		const attempted: string[] = [];
		const events = await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					now: () => NOW,
				},
				affinityKey: "ordinary-agent-session",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return attempted.length === 1
						? stream(startEvent(), errorEvent("401 unauthorized"))
						: stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(attempted).toHaveLength(2);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
	});

	test("policy disables affinity and selects in declaration order", async () => {
		const affinityKey = "affinity-off-regression-0";
		const sources = {
			providerId: "test",
			credential: pooled(),
			env: () => undefined,
			repository,
			now: () => NOW,
		};
		const slots = await listRotationSlots(sources);
		const declarationOrder = slots.map((slot) => slot.name);
		const affinityOrder = rendezvousOrder(affinityKey, slots, sha256SlotHasher).map((slot) => slot.name);
		expect(affinityOrder).not.toEqual(declarationOrder);

		const affinityChosen: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources,
				affinityKey,
				hasher: sha256SlotHasher,
				runAttempt: (slot) => {
					affinityChosen.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(affinityChosen).toEqual([affinityOrder[0]]);

		const policyChosen: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: { ...sources, policy: { affinity: false } },
				affinityKey,
				hasher: sha256SlotHasher,
				runAttempt: (slot) => {
					policyChosen.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(policyChosen).toEqual([declarationOrder[0]]);
	});

	test("pinned account wins selection over HRW affinity", async () => {
		const attempted: string[] = [];
		const pinnedCredential: PooledCredential = { ...pooled(), pinned: "work" };
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pinnedCredential,
					env: () => undefined,
					repository,
				},
				affinityKey: "pin-regression",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(attempted).toEqual(["work"]);
	});

	test("expired stored cooldown admits and runs exactly one probe", async () => {
		const defaultRevision = await repository.storedCredentialRevision("test", "default", { key: "key-default" });
		const workRevision = await repository.storedCredentialRevision("test", "work", { key: "key-work" });
		await repository.mutateSlotState("test", "stored", "default", () => ({
			blockedUntil: NOW - 1,
			blockReason: "rate_limit",
			credentialRevision: defaultRevision,
		}));
		await repository.mutateSlotState("test", "stored", "work", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
			credentialRevision: workRevision,
		}));
		const attempted: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					now: () => NOW,
				},
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("probe-ok"));
				},
			}),
		);
		expect(attempted).toEqual(["default"]);
	});

	test("expired env cooldown admits exactly one leased probe", async () => {
		const env = (name: string) => ({ OPENAI_API_KEY: "key-one", OPENAI_API_KEY_2: "key-two" })[name];
		const revision = await repository.envCredentialRevision("OPENAI_API_KEY", "key-one");
		await repository.mutateSlotState("openai", "env", "env", () => ({
			blockedUntil: NOW - 1,
			blockReason: "rate_limit",
			credentialRevision: revision,
		}));
		const sources = { providerId: "openai", credential: undefined, env, repository, now: () => NOW };
		const first = await listRotationSlots(sources);
		const second = await listRotationSlots(sources);
		expect(first.find((slot) => slot.name === "env")?.lease).toBeDefined();
		expect(second.some((slot) => slot.name === "env")).toBe(false);
	});

	test("policy cooldown base controls the first rate limit cooldown", async () => {
		const attempted: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					policy: { cooldownBaseMs: 5, cooldownCapMs: 100 },
					now: () => NOW,
				},
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), errorEvent("429 rate limited"));
				},
			}),
		).catch(() => undefined);
		const state = await repository.listSlots("test", "stored");
		expect(state[attempted[0] ?? ""]?.blockedUntil).toBe(NOW + 5);
	});

	test("policy cooldown cap is applied to persisted rate limits", async () => {
		const attempted: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					policy: { cooldownBaseMs: 5, cooldownCapMs: 10 },
					now: () => NOW,
				},
				affinityKey: "policy-cooldown",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), errorEvent("429 rate limited"));
				},
			}),
		).catch(() => undefined);
		const state = await repository.listSlots("test", "stored");
		expect(state[attempted[0] ?? ""]?.blockedUntil).toBe(NOW + 5);
	});

	test("named policy slots join stored credential rotation", async () => {
		const attempted: string[] = [];
		await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => "named-key",
					repository,
					policy: { slots: { broker: { value: "named-key" } } },
				},
				affinityKey: "named-slot",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(attempted).toContain("broker");
	});

	test("successful pooled request completes after selection", async () => {
		const defaultRevision = await repository.storedCredentialRevision("test", "default", { key: "key-default" });
		await repository.mutateSlotState("test", "stored", "default", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
			credentialRevision: defaultRevision,
		}));
		await repository.mutateSlotState("test", "stored", "work", () => ({}));
		const attempted: string[] = [];
		const events = await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					policy: { affinity: false },
					now: () => NOW,
				},
				affinityKey: "probe-regression",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("ok"));
				},
			}),
		);
		expect(attempted).toEqual(["work"]);
		expect(events.some((event) => event.type === "text_delta" && event.delta === "ok")).toBe(true);
		const successfulState = (await repository.listSlots("test", "stored")).work;
		expect(successfulState?.lastSuccessAt).toBe(NOW);
		expect(successfulState?.lease).toBeUndefined();
		expect(successfulState?.blockedUntil).toBeUndefined();
		expect(successfulState?.blockReason).toBeUndefined();
	});
	test("lists both stored slots with sidecar health overlaid", async () => {
		const workRevision = await repository.storedCredentialRevision("test", "work", { key: "key-work" });
		await repository.mutateSlotState("test", "stored", "work", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
			credentialRevision: workRevision,
		}));

		const slots = await listRotationSlots({
			providerId: "test",
			credential: pooled(),
			env: () => undefined,
			repository,
		});

		expect(slots.map((slot) => slot.name)).toEqual(["default", "work"]);
		expect(slots[1]).toMatchObject({
			lane: "stored",
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
		});
	});

	test("a 429 before any delta rotates to the sibling slot and persists the cooldown", async () => {
		const attempted: string[] = [];
		const events = await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
					now: () => NOW,
				},
				affinityKey: "session-1",
				hasher: sha256SlotHasher,
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return attempted.length === 1
						? stream(startEvent(), errorEvent("429 rate limited"))
						: stream(startEvent(), textEvent("hello"));
				},
			}),
		);

		expect(attempted).toHaveLength(2);
		expect(attempted[0]).not.toBe(attempted[1]);
		expect(events.some((event) => event.type === "text_delta")).toBe(true);
		const persisted = await repository.listSlots("test", "stored");
		const blocked = persisted[attempted[0] ?? ""];
		expect(blocked).toMatchObject({ blockReason: "rate_limit" });
		expect(blocked?.blockedUntil).toBe(NOW + 60_000);
	});

	test("the same affinity key sticks to the same slot with no config present", async () => {
		const chosen: string[] = [];
		for (let index = 0; index < 3; index++) {
			await collect(
				streamWithCredentialRotation({
					sources: {
						providerId: "test",
						credential: pooled(),
						env: () => undefined,
						repository,
					},
					affinityKey: "stable-session",
					runAttempt: (slot) => {
						chosen.push(slot.name);
						return stream(startEvent(), textEvent("ok"));
					},
				}),
			);
		}
		expect(new Set(chosen).size).toBe(1);
	});

	test("a failure after a delta never rotates and forwards the provider's own terminal event", async () => {
		const attempted: string[] = [];
		const seen = await collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: pooled(),
					env: () => undefined,
					repository,
				},
				affinityKey: "session-2",
				runAttempt: (slot) => {
					attempted.push(slot.name);
					return stream(startEvent(), textEvent("partial"), errorEvent("429 rate limited"));
				},
			}),
		);
		expect(attempted).toHaveLength(1);
		const terminal = seen.at(-1);
		expect(terminal?.type).toBe("error");
		// The session layer decides replay from the provider's own text; the pool
		// must not stamp a marker that would disable retry and fallback outright.
		expect(terminal?.type === "error" ? terminal.error.errorMessage : undefined).toBe("429 rate limited");
	});

	test("env slots form a pool and a rotated env value clears its own stale block", async () => {
		const env = (name: string) => ({ OPENAI_API_KEY: "sk-one", OPENAI_API_KEY_2: "sk-two" })[name];
		const staleRevision = await repository.envCredentialRevision("OPENAI_API_KEY", "sk-old");
		await repository.mutateSlotState("openai", "env", "env", () => ({
			blockedUntil: NOW + 600_000,
			blockReason: "rate_limit",
			credentialRevision: staleRevision,
		}));

		const slots = await listRotationSlots({
			providerId: "openai",
			credential: undefined,
			env,
			repository,
		});

		expect(slots.map((slot) => slot.name)).toEqual(["env", "env-2"]);
		// The persisted block belonged to the previous value of OPENAI_API_KEY.
		expect(slots[0]?.blockedUntil).toBeUndefined();
	});
});

/**
 * Account rows reread the listing only when the engine says a provider's accounts changed
 * (sisyphuslabs/omo-desktop-app#4203). Health the generic pool commits is such a change even when
 * no other account takes over, and the notice may only follow a write that landed.
 */
describe("committed pool health publishes an account-change notice", () => {
	// A clock past the real one, so the listing (which reads the real clock) sees these blocks as live.
	const LATER = 4_102_444_800_000;
	const solo: PooledCredential = {
		type: "api_key",
		key: "key-solo",
		accounts: [{ name: "solo", key: "key-solo", source: "login" }],
	};
	let heldLock: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await heldLock?.();
		heldLock = undefined;
	});

	function statePath(): string {
		return join(dir, "credential-pool-state.json");
	}

	function persistedSolo(): CredentialSlotState | undefined {
		const document = JSON.parse(readFileSync(statePath(), "utf-8"));
		return document.providers?.test?.lanes?.stored?.slots?.solo;
	}

	/** Records each notice with the slot health on disk at the moment it fired. */
	function watchNotices() {
		const notices: { provider: string; atNotice: CredentialSlotState | undefined }[] = [];
		let arrive: () => void = () => undefined;
		const first = new Promise<void>((resolve) => {
			arrive = resolve;
		});
		const unsubscribe = subscribeProviderAccountEvents((event) => {
			if (event.type !== "accounts_changed") return;
			notices.push({ provider: event.provider, atNotice: persistedSolo() });
			arrive();
		});
		const arrived = async (): Promise<void> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("no account-change notice within 5 s")), 5_000);
			});
			try {
				await Promise.race([first, deadline]);
			} finally {
				clearTimeout(timer);
			}
		};
		return { notices, arrived, unsubscribe };
	}

	function rotate(source: CredentialSlotRepository, runAttempt: () => AsyncGenerator<AssistantMessageEvent>) {
		return collect(
			streamWithCredentialRotation({
				sources: {
					providerId: "test",
					credential: solo,
					env: () => undefined,
					repository: source,
					now: () => LATER,
				},
				runAttempt,
			}),
		);
	}

	async function seedLiveBlock(): Promise<void> {
		const credentialRevision = await repository.storedCredentialRevision("test", "solo", { key: "key-solo" });
		await repository.mutateSlotState("test", "stored", "solo", () => ({
			blockedUntil: LATER + 60_000,
			blockReason: "rate_limit",
			failureCount: 1,
			credentialRevision,
		}));
	}

	async function listedSolo() {
		const storage = AuthStorage.inMemory({ test: solo });
		return (await getCredentialAccounts(storage, "test", {}, repository)).find((account) => account.name === "solo");
	}

	test.each([
		["429 rate limited", "rate_limit"],
		["401 unauthorized", "auth_error"],
	] as const)(
		"a %s on the only account publishes once its block is on disk, and the reread shows it",
		async (failure, reason) => {
			const watch = watchNotices();
			try {
				const seen = await rotate(repository, () => stream(startEvent(), errorEvent(failure)));
				await watch.arrived();

				expect(seen.at(-1)?.type).toBe("error");
				expect(watch.notices).toEqual([
					{ provider: "test", atNotice: expect.objectContaining({ blockReason: reason }) },
				]);
				expect(await listedSolo()).toMatchObject({ blocked: true, blockedReason: reason });
			} finally {
				watch.unsubscribe();
			}
		},
	);

	test("a success that lifts a live block publishes once the release is on disk; a healthy success publishes nothing", async () => {
		await seedLiveBlock();
		expect(await listedSolo()).toMatchObject({ blocked: true, blockedReason: "rate_limit" });
		const watch = watchNotices();
		try {
			await rotate(repository, () => stream(startEvent(), textEvent("recovered")));
			await watch.arrived();

			expect(watch.notices).toHaveLength(1);
			expect(watch.notices[0]?.provider).toBe("test");
			expect(watch.notices[0]?.atNotice).toMatchObject({ lastSuccessAt: LATER });
			expect(watch.notices[0]?.atNotice?.blockReason).toBeUndefined();
			expect(await listedSolo()).toMatchObject({ blocked: false });

			await rotate(repository, () => stream(startEvent(), textEvent("still fine")));
			expect(watch.notices).toHaveLength(1);
		} finally {
			watch.unsubscribe();
		}
	});

	test.each([
		["block", () => stream(startEvent(), errorEvent("429 rate limited"))],
		["release", () => stream(startEvent(), textEvent("recovered"))],
	] as const)("a %s write the busy state file refused publishes nothing", async (kind, reply) => {
		if (kind === "release") await seedLiveBlock();
		await repository.listSlots("test", "stored");
		const before = persistedSolo();
		const busy = new CredentialSlotRepository(statePath(), { lockWaitBudgetMs: 50 });
		const watch = watchNotices();
		try {
			await rotate(busy, async function* () {
				heldLock = await lockfile.lock(statePath(), FILE_STORAGE_LOCK_OPTIONS);
				yield* reply();
			});

			expect(persistedSolo()).toEqual(before);
			expect(watch.notices).toEqual([]);
		} finally {
			watch.unsubscribe();
		}
	});
});
