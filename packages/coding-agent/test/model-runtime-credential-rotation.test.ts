import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { rendezvousOrder } from "@earendil-works/pi-ai/auth/pool/select";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	listRotationSlots,
	sha256SlotHasher,
	streamWithCredentialRotation,
} from "../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";
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
		runtime.registerNativeProvider(faux.provider);
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
		const events: AssistantMessageEvent[] = [];
		for await (const event of runtime.stream(
			faux.getModel(),
			{ messages: [], tools: [] },
			{ sessionId: "runtime-probe" },
		))
			events.push(event);
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
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: ["policy-only"] });
		faux.setResponses([fauxAssistantMessage("policy-ok")]);
		const events: AssistantMessageEvent[] = [];
		for await (const event of runtime.stream(faux.getModel(), { messages: [], tools: [] })) events.push(event);
		expect(events.some((event) => event.type === "done")).toBe(true);
		expect(faux.getCallLog()).toHaveLength(1);
		rmSync(dir, { recursive: true, force: true });
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
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ allowNetwork: false, providers: ["anthropic"] });
		faux.setResponses([
			() => {
				throw new Error("401 unauthorized");
			},
			fauxAssistantMessage("combined-ok"),
		]);
		const events: AssistantMessageEvent[] = [];
		for await (const event of runtime.stream(
			faux.getModel(),
			{ messages: [], tools: [] },
			{
				env: { ANTHROPIC_API_KEY: "key-env" },
			},
		))
			events.push(event);
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
		await repository.mutateSlotState("test", "stored", "default", () => ({
			blockedUntil: NOW - 1,
			blockReason: "rate_limit",
		}));
		await repository.mutateSlotState("test", "stored", "work", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
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
		await repository.mutateSlotState("test", "stored", "default", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
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
		await repository.mutateSlotState("test", "stored", "work", () => ({
			blockedUntil: NOW + 60_000,
			blockReason: "rate_limit",
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

	test("a failure after a delta never rotates and carries the suppression marker", async () => {
		const attempted: string[] = [];
		let caught: unknown;
		try {
			await collect(
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
		} catch (error) {
			caught = error;
		}
		expect(attempted).toHaveLength(1);
		expect((caught as Error).message.startsWith("senpi:no-turn-retry:")).toBe(true);
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
