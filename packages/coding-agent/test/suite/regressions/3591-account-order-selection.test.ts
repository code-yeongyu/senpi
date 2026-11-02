import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { rendezvousOrder } from "@earendil-works/pi-ai/auth/pool/select";
import { type PooledCredential, projectSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256SlotHasher, streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import type {
	AccountSlot,
	ClaudeCliAccountSlot,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	rendezvousOrder as claudeRendezvousOrder,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import {
	addAccount as addCursorAccount,
	emptyCredential as emptyCursorCredential,
	removeAccount as removeCursorAccount,
} from "../../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	rendezvousOrder as cursorRendezvousOrder,
	selectAccount as selectCursorAccount,
} from "../../../src/core/extensions/builtin/cursor-cli-oauth/affinity.ts";
import { accountFooterSuffix } from "../../../src/modes/interactive/components/footer.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

// senpi#3591: a provider's accounts can carry a user order. Selection takes the
// pin first, then the first unblocked account in the user order, then HRW for
// the accounts the order does not name. No order keeps today's HRW behavior.

const NOW = 1_756_000_000_000;
const NAMES = ["alpha", "beta", "gamma"] as const;
const AFFINITY_KEY = "senpi-3591-session";

let dir: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = join(tmpdir(), `senpi-3591-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type PoolExtra = { pinned?: string; order?: string[] };

function pool(extra: PoolExtra = {}): PooledCredential {
	return {
		type: "api_key",
		key: "key-alpha",
		accounts: NAMES.map((name) => ({ name, key: `key-${name}`, source: "login" as const })),
		...extra,
	};
}

const HRW = rendezvousOrder(
	AFFINITY_KEY,
	NAMES.map((name) => ({ name })),
	sha256SlotHasher,
).map((slot) => slot.name);
const REVERSED = [...HRW].reverse();

function message(errorMessage?: string): AssistantMessage {
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
		timestamp: NOW,
	};
}

async function* events(...items: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
	for (const item of items) yield item;
}

async function attemptsFor(credential: PooledCredential, failing: readonly string[] = []): Promise<string[]> {
	const attempted: string[] = [];
	const stream = streamWithCredentialRotation({
		sources: { providerId: "test", credential, env: () => undefined, repository, now: () => NOW },
		affinityKey: AFFINITY_KEY,
		hasher: sha256SlotHasher,
		runAttempt: (slot) => {
			attempted.push(slot.name);
			return failing.includes(slot.name)
				? events(
						{ type: "start", partial: message() },
						{ type: "error", reason: "error", error: message("401 unauthorized") },
					)
				: events(
						{ type: "start", partial: message() },
						{ type: "text_delta", contentIndex: 0, delta: "ok", partial: message() },
					);
		},
	});
	const seen: AssistantMessageEvent[] = [];
	for await (const event of stream) seen.push(event);
	expect(seen.some((event) => event.type === "text_delta")).toBe(true);
	return attempted;
}

describe("senpi#3591 account order: the generic rotation path", () => {
	it("serves the first ordered account even when HRW ranks it last", async () => {
		expect(await attemptsFor(pool({ order: REVERSED }))).toEqual([REVERSED[0]]);
	});

	it("fails over down the user order", async () => {
		expect(await attemptsFor(pool({ order: REVERSED }), [REVERSED[0]!])).toEqual([REVERSED[0], REVERSED[1]]);
	});

	it("puts accounts the order does not name after the ordered ones, in HRW order", async () => {
		const last = REVERSED[0]!;
		const rest = HRW.filter((name) => name !== last);
		expect(await attemptsFor(pool({ order: [last] }), [last, rest[0]!])).toEqual([last, rest[0], rest[1]]);
	});

	it("still lets a pin win over the order", async () => {
		expect(await attemptsFor(pool({ order: REVERSED, pinned: REVERSED[2] }))).toEqual([REVERSED[2]]);
	});

	it("keeps HRW when no order is set", async () => {
		expect(await attemptsFor(pool())).toEqual([HRW[0]]);
	});
});

describe("senpi#3591 account order: the Claude subscription lane", () => {
	function account(name: string, extra: Partial<ClaudeCliAccountSlot> = {}): AccountSlot {
		return cliSlot(name, extra);
	}
	const accounts = NAMES.map((name) => account(name));
	const claudeHrw = claudeRendezvousOrder(AFFINITY_KEY, accounts).map((entry) => entry.name);
	const claudeReversed = [...claudeHrw].reverse();

	it("selects the first ordered account over the HRW winner", () => {
		expect(selectAccount(accounts, { affinityKey: AFFINITY_KEY, accountOrder: claudeReversed, now: NOW }).name).toBe(
			claudeReversed[0],
		);
	});

	it("skips a blocked ordered account for the next one in the order", () => {
		const blocked = accounts.map((entry) =>
			entry.name === claudeReversed[0] ? { ...entry, blockedUntil: NOW + 60_000, blockReason: "rate_limit" } : entry,
		);
		expect(selectAccount(blocked, { affinityKey: AFFINITY_KEY, accountOrder: claudeReversed, now: NOW }).name).toBe(
			claudeReversed[1],
		);
	});

	it("keeps the pin and the session's own account ahead of the order", () => {
		expect(
			selectAccount(accounts, {
				affinityKey: AFFINITY_KEY,
				accountOrder: claudeReversed,
				pinnedAccount: claudeReversed[2],
				now: NOW,
			}).name,
		).toBe(claudeReversed[2]);
		expect(
			selectAccount(accounts, {
				affinityKey: AFFINITY_KEY,
				accountOrder: claudeReversed,
				preferredAccount: claudeReversed[1],
				now: NOW,
			}).name,
		).toBe(claudeReversed[1]);
	});
});

describe("senpi#3591 account order: the Cursor CLI lane", () => {
	const accounts = NAMES.map((name) => ({ name }));
	const cursorReversed = cursorRendezvousOrder(AFFINITY_KEY, accounts)
		.map((entry) => entry.name)
		.reverse();

	it("selects the first ordered account over the HRW winner, and the pin over the order", () => {
		expect(
			selectCursorAccount(accounts, { affinityKey: AFFINITY_KEY, accountOrder: cursorReversed, now: NOW }).name,
		).toBe(cursorReversed[0]);
		expect(
			selectCursorAccount(accounts, {
				affinityKey: AFFINITY_KEY,
				accountOrder: cursorReversed,
				pinnedAccount: cursorReversed[2],
				now: NOW,
			}).name,
		).toBe(cursorReversed[2]);
	});

	it("drops a removed account from the stored order", () => {
		const credential = NAMES.reduce(
			(current, name) =>
				addCursorAccount(current, {
					name,
					access: `a-${name}`,
					refresh: `r-${name}`,
					expires: NOW,
					source: "login",
				}),
			emptyCursorCredential(),
		);
		expect(removeCursorAccount({ ...credential, order: ["beta", "gamma"] }, "beta").order).toEqual(["gamma"]);
	});
});

describe("senpi#3591 account order: what the TUI shows and hands to providers", () => {
	it("names the first ordered account in the footer, and the pin over it", () => {
		expect(accountFooterSuffix(pool({ order: REVERSED }), AFFINITY_KEY)).toBe(`@${REVERSED[0]}`);
		expect(accountFooterSuffix(pool({ order: REVERSED, pinned: REVERSED[2] }), AFFINITY_KEY)).toBe(`@${REVERSED[2]}`);
		expect(accountFooterSuffix(pool(), AFFINITY_KEY)).toBe(`@${HRW[0]}`);
	});

	it("strips the order from the projected per-account credential", () => {
		expect(projectSlot(pool({ order: ["beta"] }), "beta")).not.toHaveProperty("order");
	});
});
