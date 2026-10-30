import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent, ProviderDiagnostic } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COOLDOWN_BASE_MS } from "../../../src/core/credential-pool/classify.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#3216: the ChatGPT adapter words every 429 that carries an error object as a spent
// account ("You have hit your ChatGPT usage limit ... Try again in ~N min."), and the pool read
// that prose. A per-request `rate_limit_exceeded` throttle with a far reset therefore blocked an
// account for the whole reset. The adapter already mints the provider's own code in a
// structured diagnostic; the pool must decide from that code before it reads any prose.

const PROVIDER = "chatgpt-subscription";
const START = Date.UTC(2026, 9, 30, 0, 0, 0);
const HOUR = 60 * 60_000;
const SPENT_PROSE = "You have hit your ChatGPT usage limit (plus plan). Upgrade to Pro. Try again in ~1800 min.";

let dir: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-3216-pool-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
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

function refusal(diagnostic: ProviderDiagnostic): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
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
		stopReason: "error",
		errorMessage: SPENT_PROSE,
		providerDiagnostic: diagnostic,
		timestamp: START,
	};
}

async function* served(): AsyncGenerator<AssistantMessageEvent> {
	const message = { ...refusal({ category: "unknown", evidence: "structured_status" }), stopReason: "stop" as const };
	const { errorMessage: _errorMessage, providerDiagnostic: _diagnostic, ...ok } = message;
	yield { type: "done", reason: "stop", message: ok };
}

async function alphaBlockMs(diagnostic: ProviderDiagnostic): Promise<number> {
	const stream = streamWithCredentialRotation({
		sources: {
			providerId: PROVIDER,
			credential: twoAccounts(),
			env: () => undefined,
			repository,
			policy: { affinity: false },
			now: () => START,
		},
		runAttempt: async function* (slot) {
			if (slot.name === "alpha") {
				yield { type: "error", reason: "error", error: refusal(diagnostic) };
				return;
			}
			yield* served();
		},
	});
	for await (const _event of stream) {
		// drain
	}
	const until = (await repository.listSlots(PROVIDER, "stored")).alpha?.blockedUntil;
	if (until === undefined) throw new Error("expected alpha to be blocked");
	return until - START;
}

describe("senpi#3216: the provider's structured code outranks the limit prose", () => {
	it("#given a rate_limit_exceeded throttle worded as a spent account #when alpha is blocked #then it cools down briefly, not until the far reset", async () => {
		const blockMs = await alphaBlockMs({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_exceeded",
			evidence: "structured_code",
			resetsAt: START + 30 * HOUR,
		});

		expect(blockMs).toBe(COOLDOWN_BASE_MS);
	});

	it("#given a usage_limit_reached refusal whose reset is only in the diagnostic #when alpha is blocked #then it stays out until that reset", async () => {
		const blockMs = await alphaBlockMs({
			category: "quota",
			httpStatus: 429,
			code: "usage_limit_reached",
			evidence: "structured_code",
			resetsAt: START + 2 * HOUR,
		});

		expect(blockMs).toBe(2 * HOUR);
	});
});
