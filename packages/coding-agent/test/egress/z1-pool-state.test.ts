import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type RotationSources, streamWithCredentialRotation } from "../../src/core/credential-pool/rotation-stream.ts";
import {
	BLOCK_LOG_FILENAME,
	CredentialSlotRepository,
	type CredentialSlotState,
} from "../../src/core/credential-pool/state-store.ts";
import type { PoolState } from "../../src/core/egress/pool-state.ts";

/**
 * senpi#5835 (CK10a, Z1): rotation reads and writes pool health only through the `PoolState` port. The fused
 * implementation is today's file-backed repository, so these sequences pin what a CLI user's pool does and
 * writes: which account each request tries in which order, what an exhausted pool answers, and how a cooled
 * account is probed and recovered. A hosted brain plugs its own state into the same port.
 */

const NOW = 1_800_000_000_000;
const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_CAP_MS = 600_000;
const STATE_FILE = "credential-pool-state.json";

type Plan = Readonly<Record<string, "ok" | "limit">>;
const PROBE_LEASE_TTL_MS = 30_000;
const EXHAUSTED_AT = NOW + 2_000;
const RECOVERED_AT = NOW + COOLDOWN_CAP_MS + 10_000;

type Step = { name: string; at: number; plan: Plan };

const SEQUENCE: readonly Step[] = [
	{ name: "limited accounts fail over", at: NOW, plan: { a: "limit", b: "limit", c: "ok" } },
	{ name: "cooling accounts are skipped", at: NOW + 1_000, plan: { a: "ok", b: "ok", c: "ok" } },
	{ name: "every account limited", at: EXHAUSTED_AT, plan: { a: "limit", b: "limit", c: "limit" } },
	{ name: "cooldowns elapsed", at: RECOVERED_AT, plan: { a: "ok", b: "ok", c: "ok" } },
];

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "z1-pool",
		model: "z1-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

async function* answer(): AsyncGenerator<AssistantMessageEvent> {
	yield { type: "start", partial: message() };
	yield { type: "done", reason: "stop", message: message({ content: [{ type: "text", text: "ok" }] }) };
}

async function* limited(): AsyncGenerator<AssistantMessageEvent> {
	yield* [];
	throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
}

/** The pool health a run left, with installation-bound HMACs and lease ids replaced by first-seen labels. */
function normalize(value: unknown): unknown {
	const labels = new Map<string, string>();
	const label = (raw: string, kind: string) => {
		const existing = labels.get(raw);
		if (existing !== undefined) return existing;
		const next = `<${kind}#${labels.size + 1}>`;
		labels.set(raw, next);
		return next;
	};
	return JSON.parse(JSON.stringify(value), (_key, field: unknown) => {
		if (typeof field !== "string") return field;
		if (/^[0-9a-f]{64}$/.test(field)) return label(field, "revision");
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(field)) return label(field, "lease");
		return field;
	});
}

/** A pool state outside the file store, as a hosted brain supplies one. */
class MemoryPoolState implements PoolState {
	readonly providers: Record<string, { lanes: Record<string, { slots: Record<string, CredentialSlotState> }> }> = {};

	async listSlots(providerId: string, laneId: string): Promise<Record<string, CredentialSlotState>> {
		return { ...this.providers[providerId]?.lanes[laneId]?.slots };
	}

	async mutateSlotState(
		providerId: string,
		laneId: string,
		slotId: string,
		fn: (current: CredentialSlotState | undefined) => Omit<CredentialSlotState, "stateVersion"> | undefined,
	): Promise<CredentialSlotState | undefined> {
		const provider = (this.providers[providerId] ??= { lanes: {} });
		const lane = (provider.lanes[laneId] ??= { slots: {} });
		const current = lane.slots[slotId];
		const mutated = fn(current);
		if (mutated === undefined) {
			delete lane.slots[slotId];
			return undefined;
		}
		const next = JSON.parse(
			JSON.stringify({ ...mutated, stateVersion: (current?.stateVersion ?? 0) + 1 }),
		) as CredentialSlotState;
		lane.slots[slotId] = next;
		return next;
	}

	async storedSlotRevisions(
		providerId: string,
		slotName: string,
		material: { key?: string; access?: string; refresh?: string },
	): Promise<{ account: string; material: string }> {
		return {
			account: digest(`account\0${providerId}\0${slotName}\0${material.key ?? ""}`),
			material: digest(
				`${providerId}\0${slotName}\0${material.key ?? ""}\0${material.access ?? ""}\0${material.refresh ?? ""}`,
			),
		};
	}

	async envCredentialRevision(envVarName: string, envValue: string): Promise<string> {
		return digest(`${envVarName}\0${envValue}`);
	}
}

function digest(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

type Lane = "stored" | "env";

function poolSources(lane: Lane, repository: PoolState, clock: { now: number }): RotationSources {
	const policy = { cooldownBaseMs: COOLDOWN_BASE_MS, cooldownCapMs: COOLDOWN_CAP_MS };
	if (lane === "stored") {
		const credential: PooledCredential = {
			type: "api_key",
			key: "key-a",
			accounts: [
				{ name: "a", key: "key-a", source: "login" },
				{ name: "b", key: "key-b", source: "login" },
				{ name: "c", key: "key-c", source: "login" },
			],
		};
		return { providerId: "z1-pool", credential, env: () => undefined, repository, policy, now: () => clock.now };
	}
	const values: Record<string, string> = { Z1_POOL_A: "env-a", Z1_POOL_B: "env-b", Z1_POOL_C: "env-c" };
	return {
		providerId: "z1-pool",
		credential: undefined,
		env: (name) => values[name],
		repository,
		policy: { ...policy, slots: { a: { env: "Z1_POOL_A" }, b: { env: "Z1_POOL_B" }, c: { env: "Z1_POOL_C" } } },
		now: () => clock.now,
	};
}

type StepTrace = { step: string; attempts: string[]; outcome: string; health: unknown };

async function runSequence(
	lane: Lane,
	repository: PoolState,
	readHealth: () => Promise<unknown>,
): Promise<StepTrace[]> {
	const clock = { now: NOW };
	const traces: StepTrace[] = [];
	for (const step of SEQUENCE) {
		clock.now = step.at;
		const attempts: string[] = [];
		const stream = streamWithCredentialRotation({
			sources: poolSources(lane, repository, clock),
			affinityKey: "z1-pool-session",
			runAttempt: (slot) => {
				attempts.push(slot.name);
				return step.plan[slot.name] === "ok" ? answer() : limited();
			},
		});
		let outcome = "none";
		try {
			for await (const event of stream) {
				if (event.type === "done") outcome = "done";
				if (event.type === "error") outcome = `error: ${event.error.errorMessage}`;
			}
		} catch (error) {
			outcome = `throw: ${error instanceof Error ? error.message : String(error)}`;
		}
		traces.push({ step: step.name, attempts, outcome, health: await readHealth() });
	}
	return normalize(traces) as StepTrace[];
}

describe("credential-pool rotation through the PoolState port (senpi#5835, Z1)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "z1-pool-state-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function fileSequence(lane: Lane) {
		const path = join(dir, STATE_FILE);
		const repository = new CredentialSlotRepository(path);
		const traces = await runSequence(lane, repository, async () => {
			const document = JSON.parse(readFileSync(path, "utf8")) as { providers: unknown };
			return document.providers;
		});
		return { traces, files: readdirSync(dir).sort() };
	}

	test.each(["stored", "env"] as const)("%s lane: the file-backed pool keeps today's sequence", async (lane) => {
		const { traces, files } = await fileSequence(lane);

		// The file-backed pool also records each block in its local block log (senpi#3216).
		expect(files).toEqual([BLOCK_LOG_FILENAME, STATE_FILE].sort());
		expect(traces).toEqual(golden(lane));
	});

	test.each(["stored", "env"] as const)("%s lane: an in-memory PoolState drives the same sequence", async (lane) => {
		const memory = new MemoryPoolState();
		const traces = await runSequence(lane, memory, async () => structuredClone(memory.providers));

		expect(traces).toEqual(golden(lane));
	});
});

function cooling(blockedUntil: number, revision: number) {
	return {
		stateVersion: 1,
		blockedUntil,
		blockReason: "rate_limit",
		failureCount: 1,
		credentialRevision: `<revision#${revision}>`,
	};
}

function golden(lane: Lane): StepTrace[] {
	const health = (slots: Record<string, object>) => ({ "z1-pool": { lanes: { [lane]: { slots } } } });
	const a = cooling(NOW + COOLDOWN_BASE_MS, 1);
	const b = cooling(NOW + COOLDOWN_BASE_MS, 2);
	const c = cooling(EXHAUSTED_AT + COOLDOWN_BASE_MS, 3);
	const probe = (id: number) => ({ id: `<lease#${id}>`, expiresAt: RECOVERED_AT + PROBE_LEASE_TTL_MS });
	return [
		{ step: "limited accounts fail over", attempts: ["a", "b", "c"], outcome: "done", health: health({ a, b }) },
		{ step: "cooling accounts are skipped", attempts: ["c"], outcome: "done", health: health({ a, b }) },
		{
			step: "every account limited",
			attempts: ["c"],
			outcome: "throw: 429 Too Many Requests",
			health: health({ a, b, c }),
		},
		{
			step: "cooldowns elapsed",
			attempts: ["a"],
			outcome: "done",
			health: health({
				a: { stateVersion: 3, credentialRevision: "<revision#1>", lastSuccessAt: RECOVERED_AT },
				b: { ...b, stateVersion: 2, lease: probe(4) },
				c: { ...c, stateVersion: 2, lease: probe(5) },
			}),
		},
	];
}
