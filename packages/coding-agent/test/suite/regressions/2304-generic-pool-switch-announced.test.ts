import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import {
	type ProviderAccountFailoverEvent,
	subscribeProviderAccountEvents,
} from "../../../src/core/extensions/builtin/anthropic-subscription/account-events.ts";
import { formatAccountFailoverNotice } from "../../../src/modes/interactive/account-failover-notice.ts";

// senpi#2304: every automatic switch of the generic credential pool is announced exactly once as
// "from -> to" with its reason (the bus feeds RPC `account_failover` and the TUI status line);
// nothing is announced when no switch happens.

const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const PROVIDER = "fixture-pool";

type Outcome = "serve" | "unauthorized" | "rate_limited" | "billing" | "server_error" | "bad_request";

let dir: string;
let repository: CredentialSlotRepository;
let announced: ProviderAccountFailoverEvent[];
let unsubscribe: () => void;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-2304-announce-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	announced = [];
	unsubscribe = subscribeProviderAccountEvents((event) => {
		if (event.type === "failover") announced.push(event);
	});
});

afterEach(() => {
	unsubscribe();
	rmSync(dir, { recursive: true, force: true });
});

function accounts(...names: string[]): PooledCredential {
	return {
		type: "api_key",
		key: `key-${names[0]}`,
		accounts: names.map((name) => ({ name, key: `key-${name}`, source: "login" as const })),
	};
}

function message(errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: PROVIDER,
		model: "fixture-model",
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
		timestamp: NOW,
	};
}

async function* reply(outcome: Outcome): AsyncGenerator<AssistantMessageEvent> {
	yield { type: "start", partial: message() };
	if (outcome === "serve") {
		yield { type: "text_delta", contentIndex: 0, delta: "ok", partial: message() };
		yield { type: "done", reason: "stop", message: message() };
		return;
	}
	const failure = {
		unauthorized: Object.assign(message("401 Unauthorized"), {
			providerDiagnostic: { category: "auth" as const, httpStatus: 401, evidence: "structured_status" as const },
		}),
		rate_limited: message("429 Too Many Requests: rate limit exceeded"),
		billing: message("Payment required: insufficient credits"),
		server_error: Object.assign(message("500 Internal Server Error"), {
			providerDiagnostic: {
				category: "provider_unavailable" as const,
				httpStatus: 500,
				evidence: "structured_status" as const,
			},
		}),
		bad_request: Object.assign(message("400 invalid request"), {
			providerDiagnostic: {
				category: "invalid_request" as const,
				httpStatus: 400,
				evidence: "structured_status" as const,
			},
		}),
	}[outcome];
	yield { type: "error", reason: "error", error: failure };
}

async function request(credential: PooledCredential, outcomes: Record<string, Outcome[]>) {
	const attempts: string[] = [];
	const stream = streamWithCredentialRotation({
		sources: {
			providerId: PROVIDER,
			credential,
			env: () => undefined,
			repository,
			policy: { affinity: false },
			now: () => NOW,
		},
		runAttempt: (slot) => {
			attempts.push(slot.name);
			return reply(outcomes[slot.name]?.shift() ?? "serve");
		},
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { attempts, events };
}

describe("generic credential pool announces every automatic account switch (senpi#2304)", () => {
	test.each([
		["unauthorized", "auth_error"],
		["rate_limited", "rate_limit"],
		["billing", "billing"],
	] as const)("a %s first account: one failover event from -> to with reason %s", async (outcome, reason) => {
		const { attempts, events } = await request(accounts("alpha", "bravo"), { alpha: [outcome] });

		expect(attempts).toEqual(["alpha", "bravo"]);
		expect(events.at(-1)?.type).toBe("done");
		expect(announced).toEqual([{ type: "failover", provider: PROVIDER, from: "alpha", to: "bravo", reason }]);
	});

	test("two switches in one request are each announced once, in order", async () => {
		await request(accounts("alpha", "bravo", "charlie"), { alpha: ["unauthorized"], bravo: ["rate_limited"] });

		expect(announced.map(({ from, to, reason }) => `${from}->${to}:${reason}`)).toEqual([
			"alpha->bravo:auth_error",
			"bravo->charlie:rate_limit",
		]);
	});

	test.each([
		["the first account serves", { alpha: ["serve"] as Outcome[] }],
		["a server error retries the same account", { alpha: ["server_error"] as Outcome[] }],
		["a request error fails the request", { alpha: ["bad_request"] as Outcome[] }],
	])("no switch, no announcement: %s", async (_label, outcomes) => {
		await request(accounts("alpha", "bravo"), outcomes);

		expect(announced).toEqual([]);
	});

	test("the TUI status line names the provider, both accounts and the reason", async () => {
		await request(accounts("alpha", "bravo"), { alpha: ["unauthorized"] });

		expect(announced.map(formatAccountFailoverNotice)).toEqual([
			`Switched ${PROVIDER} account alpha -> bravo: its login expired or was refused.`,
		]);
	});

	test("the last account failing has nowhere to switch to: nothing is announced", async () => {
		await request(accounts("alpha"), { alpha: ["unauthorized"] });

		expect(announced).toEqual([]);
	});
});
