import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { addAccount, emptyCredential } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import type { SDKMessage, SdkQuery } from "../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";

// Regression for senpi#2555 / oh-my-openagent#9421: a one-model quota limit on an
// Anthropic subscription account must block only that model on that account.

const FABLE = "claude-fable-5-1";
const OPUS = "claude-opus-5-5";
const START = Date.UTC(2026, 9, 2, 10, 0, 0);
const HOUR = 60 * 60_000;
// The exact texts Claude Code renders from the representative rate-limit claim.
const FABLE_LIMIT = "You've hit your Fable limit · resets 1pm (UTC)";
const SESSION_LIMIT = "You've hit your session limit · resets 1pm (UTC)";

type Reply = "ok" | string;

let clock = START;

async function soloAccountStore(): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () =>
		addAccount(emptyCredential(), {
			name: "solo",
			access: "solo-access",
			refresh: "solo-refresh",
			expires: START + 30 * 24 * HOUR,
			source: "login",
		}),
	);
	return store;
}

function scriptedQuery(reply: (model: string | undefined) => Reply, served: string[]): SdkQuery {
	return (input) => {
		const model = input.options?.model;
		const answer = reply(model);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				if (answer === "ok") {
					served.push(model ?? "unknown");
					yield { type: "result", subtype: "success", result: "ok" } as SDKMessage;
					return;
				}
				yield { type: "result", subtype: "error_during_execution", errors: [answer] } as unknown as SDKMessage;
			},
			async interrupt() {},
			close() {},
		};
	};
}

async function request(model: string, query: SdkQuery): Promise<"served" | string> {
	try {
		for await (const _message of queryWithAuthLane({
			prompt: "",
			query,
			model,
			buildOptions: () => ({ model }),
			providerSettings: {},
		})) {
			// drain
		}
		return "served";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function configure(store: CredentialStore): void {
	overrideAuthLaneBoundary({ createStore: () => store, env: () => ({}), now: () => clock });
}

afterEach(() => {
	resetAuthLaneBoundary();
	clock = START;
});

describe("anthropic-subscription model-scoped quota limits (senpi#2555)", () => {
	it("#given the Fable quota is exhausted on the only account #when Opus is requested #then that account still serves it", async () => {
		const store = await soloAccountStore();
		configure(store);
		const served: string[] = [];
		const query = scriptedQuery((model) => (model === FABLE ? FABLE_LIMIT : "ok"), served);

		const fable = await request(FABLE, query);
		const opus = await request(OPUS, query);

		expect({ fable, opus, served }).toEqual({
			fable: expect.stringContaining("Fable limit"),
			opus: "served",
			served: [OPUS],
		});
	});

	it("#given an account-wide session limit #when any other model is requested #then the account stays blocked for it", async () => {
		const store = await soloAccountStore();
		configure(store);
		const served: string[] = [];
		const query = scriptedQuery((model) => (model === FABLE ? SESSION_LIMIT : "ok"), served);

		await request(FABLE, query);
		const opus = await request(OPUS, query);

		expect({ opus, served }).toEqual({
			opus: expect.stringContaining("All Anthropic Subscription accounts are blocked until"),
			served: [],
		});
	});

	it("#given a Fable block with a reset time #when the reset passes #then Fable is served again without a re-login", async () => {
		const store = await soloAccountStore();
		configure(store);
		const served: string[] = [];
		let fableSpent = true;
		const query = scriptedQuery((model) => (model === FABLE && fableSpent ? FABLE_LIMIT : "ok"), served);

		await request(FABLE, query);
		fableSpent = false;
		clock = START + 3 * HOUR - 60_000;
		const beforeReset = await request(FABLE, query);
		const opusMeanwhile = await request(OPUS, query);
		clock = START + 3 * HOUR;
		const atReset = await request(FABLE, query);

		expect({ beforeReset, opusMeanwhile, atReset, served }).toEqual({
			beforeReset: expect.stringContaining(`usage limit for model ${FABLE}`),
			opusMeanwhile: "served",
			atReset: "served",
			served: [OPUS, FABLE],
		});
	});
});
