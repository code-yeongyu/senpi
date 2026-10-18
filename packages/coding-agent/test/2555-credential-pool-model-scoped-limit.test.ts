import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamWithCredentialRotation } from "../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";

// Regression for senpi#2555: the generic credential pool (two or more stored
// accounts) must scope a one-model quota limit to that model on that account.

const PROVIDER = "anthropic-subscription";
const FABLE = "claude-fable-5-1";
const OPUS = "claude-opus-5-5";
const START = Date.UTC(2026, 9, 2, 10, 0, 0);
const HOUR = 60 * 60_000;
const FABLE_LIMIT = "You've hit your Fable limit · resets 1pm (UTC)";

let dir: string;
let statePath: string;
let repository: CredentialSlotRepository;
let clock = START;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-2555-pool-"));
	statePath = join(dir, "credential-pool-state.json");
	repository = new CredentialSlotRepository(statePath);
	clock = START;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function twoAccounts(): PooledCredential {
	return {
		type: "oauth",
		access: "managed",
		refresh: "managed",
		expires: START + 30 * 24 * HOUR,
		accounts: [
			{ name: "alpha", access: "alpha-access", refresh: "alpha-refresh", source: "login" },
			{ name: "bravo", access: "bravo-access", refresh: "bravo-refresh", source: "login" },
		],
	};
}

function message(errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "claude-sdk-oauth",
		provider: PROVIDER,
		model: "test",
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
		timestamp: START,
	};
}

async function* reply(errorText: string | undefined): AsyncGenerator<AssistantMessageEvent> {
	if (errorText !== undefined) {
		yield { type: "error", reason: "error", error: message(errorText) };
		return;
	}
	yield { type: "start", partial: message() };
	yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: message() };
	yield { type: "done", reason: "stop", message: message() };
}

type Attempt = `${string}:${string}`;

/** Runs one request for `model`; alpha answers Fable with `alphaFable` (null serves), everything else serves. */
async function request(model: string, attempts: Attempt[], alphaFable: string | null = FABLE_LIMIT) {
	const stream = streamWithCredentialRotation({
		sources: {
			providerId: PROVIDER,
			credential: twoAccounts(),
			env: () => undefined,
			repository,
			policy: { affinity: false },
			now: () => clock,
		},
		modelId: model,
		runAttempt: (slot) => {
			attempts.push(`${slot.name}:${model}`);
			return reply(slot.name === "alpha" && model === FABLE ? (alphaFable ?? undefined) : undefined);
		},
	});
	for await (const _event of stream) {
		// drain
	}
}

describe("credential pool model-scoped quota limits (senpi#2555)", () => {
	it("#given alpha's Fable quota is exhausted #when Opus is requested #then alpha still serves Opus", async () => {
		const attempts: Attempt[] = [];

		await request(FABLE, attempts);
		await request(OPUS, attempts);

		expect(attempts).toEqual([`alpha:${FABLE}`, `bravo:${FABLE}`, `alpha:${OPUS}`]);
	});

	it("#given alpha serves Opus after its Fable limit #when Fable is requested again #then alpha is skipped until the Fable reset", async () => {
		const attempts: Attempt[] = [];

		await request(FABLE, attempts);
		await request(OPUS, attempts);
		clock = START + 3 * HOUR - 60_000;
		await request(FABLE, attempts);
		clock = START + 3 * HOUR;
		await request(FABLE, attempts, null);

		expect(attempts).toEqual([
			`alpha:${FABLE}`,
			`bravo:${FABLE}`,
			`alpha:${OPUS}`,
			`bravo:${FABLE}`,
			`alpha:${FABLE}`,
		]);
	});

	it("#given a state file from before model-scoped blocks with an account-level rate limit #when requests arrive #then it is honoured until it expires", async () => {
		const installationKey = await repository.installationKey();
		const credentialRevision = await repository.storedCredentialRevision(PROVIDER, "alpha", {
			access: "alpha-access",
			refresh: "alpha-refresh",
		});
		writeFileSync(
			statePath,
			JSON.stringify({
				schemaVersion: 1,
				installationKey,
				providers: {
					[PROVIDER]: {
						lanes: {
							stored: {
								slots: {
									alpha: {
										stateVersion: 4,
										blockedUntil: START + HOUR,
										blockReason: "rate_limit",
										failureCount: 1,
										credentialRevision,
									},
								},
							},
						},
					},
				},
			}),
		);
		const attempts: Attempt[] = [];

		await request(OPUS, attempts);
		clock = START + HOUR;
		await request(OPUS, attempts);

		expect(attempts).toEqual([`bravo:${OPUS}`, `alpha:${OPUS}`]);
	});
});
