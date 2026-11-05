import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BLOCK_LOG_MAX_BYTES,
	type CredentialBlockLogEntry,
	redactBlockExcerpt,
} from "../../../src/core/credential-pool/block-log.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#3216: when the pool blocks a slot, a local log records the classified reason, where the reset came
// from, and a redacted excerpt of the provider's answer, with no tokens or account identifiers.

const PROVIDER = "chatgpt-subscription";
const START = Date.UTC(2026, 10, 5, 0, 0, 0);
const HOUR = 60 * 60_000;

let dir: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-3216-blocklog-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const credential: PooledCredential = {
	type: "oauth",
	access: "managed",
	refresh: "managed",
	expires: START + 30 * 24 * HOUR,
	accounts: [
		{ name: "alpha", access: "alpha-access", refresh: "alpha-refresh", source: "login" },
		{ name: "bravo", access: "bravo-access", refresh: "bravo-refresh", source: "login" },
	],
};

function failure(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

async function* served(): AsyncGenerator<AssistantMessageEvent> {
	yield {
		type: "done",
		reason: "stop",
		message: {
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
			stopReason: "stop",
			timestamp: START,
		},
	};
}

async function blockAlpha(refusal: Error): Promise<void> {
	const stream = streamWithCredentialRotation({
		sources: {
			providerId: PROVIDER,
			credential,
			env: () => undefined,
			repository,
			policy: { affinity: false },
			now: () => START,
		},
		runAttempt: (slot) => {
			if (slot.name === "alpha") throw refusal;
			return served();
		},
	});
	for await (const _event of stream) {
		// drain
	}
}

function logEntries(): CredentialBlockLogEntry[] {
	const path = repository.blockLogPath();
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as CredentialBlockLogEntry);
}

describe("senpi#3216: the pool logs why it blocked a slot", () => {
	it("a usage limit records the reason, the reset it read from the text, and the reset time", async () => {
		await blockAlpha(failure(429, "You've hit your usage limit. Your limit resets 9am (UTC)."));

		const [entry] = logEntries();
		expect(entry).toMatchObject({
			provider: PROVIDER,
			slot: "alpha",
			reason: "rate_limit",
			resetSource: "reset_prose",
			blockedUntil: new Date(Date.UTC(2026, 10, 5, 9, 0, 0)).toISOString(),
		});
		expect(entry?.excerpt).toContain("usage limit");
	});

	it("a rejected sign-in records auth_error with no reset source", async () => {
		await blockAlpha(failure(401, "Unauthorized: token expired"));

		const [entry] = logEntries();
		expect(entry?.reason).toBe("auth_error");
		expect(entry?.resetSource).toBeUndefined();
	});

	it("the excerpt never carries tokens or account identifiers", async () => {
		await blockAlpha(
			failure(
				429,
				"Rate limit reached for org-AbCdEf123456 user-ZyXw98765432 (owner@example.com, account 0c9f2d3e-1a2b-4c3d-8e9f-0a1b2c3d4e5f) using key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
			),
		);

		const excerpt = logEntries()[0]?.excerpt ?? "";
		expect(excerpt).toContain("Rate limit reached");
		for (const secret of [
			"org-AbCdEf123456",
			"user-ZyXw98765432",
			"owner@example.com",
			"0c9f2d3e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
			"sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
		]) {
			expect(excerpt).not.toContain(secret);
		}
	});

	it("the log is private to the user and rolls over past its size bound", async () => {
		writeFileSync(repository.blockLogPath(), "x".repeat(BLOCK_LOG_MAX_BYTES));
		await blockAlpha(failure(402, "Payment required"));

		expect(existsSync(`${repository.blockLogPath()}.1`)).toBe(true);
		expect(logEntries().map((entry) => entry.reason)).toEqual(["account_disabled"]);
		expect(statSync(repository.blockLogPath()).mode & 0o777).toBe(0o600);
	});

	it("the excerpt is bounded", () => {
		expect(redactBlockExcerpt("limit ".repeat(200)).length).toBeLessThanOrEqual(241);
	});
});
