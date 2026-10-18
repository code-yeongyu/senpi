import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listRotationSlots, streamWithCredentialRotation } from "../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";

/**
 * senpi#1628: a Codex WebSocket drop inside a credential pool must neither
 * discard the partial reply the user already saw nor bar every recovery path.
 *
 * Drives the exact production composition (lazyStream over
 * streamWithCredentialRotation) with a synthetic provider stream, mirroring the
 * issue's reproduction script but against source.
 */

const MODEL = {
	id: "diagnostic-model",
	provider: "test",
	api: "openai-codex-responses",
} as unknown as Model<"openai-codex-responses">;

let dir: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "failover-terminal-event-"));
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

function sources() {
	return { providerId: "test", credential: pooled(), env: () => undefined, repository };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
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

/** The terminal message a provider adapter emits after a transport drop mid-reply. */
function transportFailure(text: string, errorMessage: string): AssistantMessage {
	return message({
		content: text ? [{ type: "text", text }] : [],
		usage: {
			input: 12,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		diagnostics: [
			{
				type: "provider_transport_failure",
				timestamp: 0,
				error: { name: "Error", message: errorMessage },
			} as NonNullable<AssistantMessage["diagnostics"]>[number],
		],
	});
}

async function* events(...items: AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
	for (const item of items) yield item;
}

const start = (): AssistantMessageEvent => ({ type: "start", partial: message() });
const thinkingStart = (): AssistantMessageEvent => ({
	type: "thinking_start",
	contentIndex: 0,
	partial: message({ content: [{ type: "thinking", thinking: "" }] }),
});
const textDelta = (text: string): AssistantMessageEvent => ({
	type: "text_delta",
	contentIndex: 0,
	delta: text,
	partial: message({ content: [{ type: "text", text }] }),
});
const textEnd = (text: string): AssistantMessageEvent => ({
	type: "text_end",
	contentIndex: 0,
	content: text,
	partial: message({ content: [{ type: "text", text }] }),
});
const done = (text: string): AssistantMessageEvent => ({
	type: "done",
	reason: "stop",
	message: message({ content: [{ type: "text", text }] }),
});
const failure = (text: string, errorMessage: string): AssistantMessageEvent => ({
	type: "error",
	reason: "error",
	error: transportFailure(text, errorMessage),
});

async function drive(runAttempt: (attempt: number) => AsyncIterable<AssistantMessageEvent>) {
	let attempts = 0;
	const stream = lazyStream(MODEL, async () =>
		streamWithCredentialRotation({
			sources: sources(),
			affinityKey: "session-1628",
			runAttempt: () => {
				attempts += 1;
				return runAttempt(attempts);
			},
		}),
	);
	const seen: string[] = [];
	for await (const event of stream) seen.push(event.type);
	const result = await stream.result();
	// The terminal frame precedes onSuccess's state write; await producer cleanup before deleting its directory.
	await stream[Symbol.asyncIterator]().return?.();
	return { attempts: () => attempts, seen, result };
}

describe("credential rotation keeps the provider's terminal message (senpi#1628)", () => {
	test("a transport fault right after the start frame retries the same slot", async () => {
		const run = await drive((attempt) =>
			attempt === 1
				? events(start(), failure("", "ECONNRESET"))
				: events(start(), textDelta("ok"), textEnd("ok"), done("ok")),
		);
		expect(run.attempts()).toBe(2);
		expect(run.result.stopReason).toBe("stop");
	});

	test("a transport fault after a bare thinking_start (no delta yet) still retries, announcing start once", async () => {
		const run = await drive((attempt) =>
			attempt === 1
				? events(start(), thinkingStart(), failure("", "ECONNRESET"))
				: events(start(), textDelta("ok"), textEnd("ok"), done("ok")),
		);
		expect(run.attempts()).toBe(2);
		// agent-loop pushes one message per start frame; the replacement attempt must not re-announce.
		expect(run.seen.filter((type) => type === "start")).toHaveLength(1);
		expect(run.seen).toEqual(["start", "thinking_start", "text_delta", "text_end", "done"]);
		expect(run.result.stopReason).toBe("stop");
	});

	test("a failure after committed text forwards the provider's original message: content, usage, diagnostics kept, no marker", async () => {
		const run = await drive(() =>
			events(
				start(),
				textDelta("already visible"),
				failure("already visible", "WebSocket closed 1006 Connection ended"),
			),
		);
		expect(run.attempts()).toBe(1);
		expect(run.seen).toEqual(["start", "text_delta", "error"]);
		expect(run.result.errorMessage).toBe("WebSocket closed 1006 Connection ended");
		expect(run.result.content).toEqual([{ type: "text", text: "already visible" }]);
		expect(run.result.usage.totalTokens).toBe(15);
		expect(run.result.diagnostics).toHaveLength(1);
	});

	test("a rotate-class failure after committed text blocks the slot but still forwards the original message unmarked", async () => {
		const run = await drive(() =>
			events(start(), textDelta("already visible"), failure("already visible", "429 rate limited")),
		);
		expect(run.attempts()).toBe(1);
		expect(run.result.errorMessage).toBe("429 rate limited");
		expect(run.result.content).toEqual([{ type: "text", text: "already visible" }]);
		const slots = await listRotationSlots(sources(), { acquireLeases: false });
		expect(slots.filter((slot) => slot.blockReason === "rate_limit")).toHaveLength(1);
	});

	test("pool exhaustion before any output forwards the last provider message with its diagnostics", async () => {
		const run = await drive(() => events(start(), failure("", "429 rate limited")));
		expect(run.attempts()).toBe(2);
		expect(run.result.errorMessage).toBe("429 rate limited");
		expect(run.result.diagnostics).toHaveLength(1);
	});
});
