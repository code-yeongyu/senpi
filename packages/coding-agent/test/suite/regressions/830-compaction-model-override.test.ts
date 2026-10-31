import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage, InMemoryAuthStorageBackend } from "../../../src/core/auth-storage.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { CredentialStoreBusyError } from "../../../src/core/lockfile-policy.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

// #830: a configured `compaction.model` must summarize builtin compaction on a
// healthy provider, not only after the session account is spent.

const SESSION_MODEL = { id: "session-model", contextWindow: 100_000, maxTokens: 8_000 };
const SUMMARY_MODEL = { id: "summary-model", contextWindow: 100_000, maxTokens: 8_000 };
const SUMMARY_REQUEST = /\[INTERNAL [A-Z -]*(?:COMPACTION|SUMMARY) INSTRUCTION/;
const SETTLE_TIMEOUT_MS = 10_000;

type Path = "threshold" | "speculative" | "idle";

// Seeded usage per path on a 100k window: threshold is above the builtin 60% trigger,
// speculative sits between its 45% warm start and the trigger, idle starts small and
// its reply lands between the builtin trigger and the core reserve threshold.
const SCENARIOS: Record<Path, { seedTokens: number; reply: string; mode?: "rpc" }> = {
	threshold: { seedTokens: 70_000, reply: "done" },
	speculative: { seedTokens: 55_000, reply: "done" },
	idle: { seedTokens: 1_000, reply: "z".repeat(200_000), mode: "rpc" },
};

interface RecordedCall {
	model: string;
	summary: boolean;
}

function lastMessageText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last) return "";
	if (typeof last.content === "string") return last.content;
	return last.content.map((part) => ("text" in part ? part.text : "")).join("");
}

function registerSummaryProvider(harness: Harness, provider: string): void {
	const session = harness.getModel();
	harness.modelRegistry.registerProvider(provider, {
		api: session.api,
		baseUrl: session.baseUrl,
		models: [{ ...SUMMARY_MODEL, name: "Summary", reasoning: false, input: ["text"], cost: session.cost }],
	});
}

function fallbackLog(harness: Harness): unknown[] {
	return readFileSync(join(harness.tempDir, "agent", "logs", "session.log"), "utf8")
		.split("\n")
		.filter((line) => line.includes('"event":"compaction_model_fallback"'))
		.map((line) => JSON.parse(line));
}

// Copied from 2249-auth-status-busy-store.test.ts: every lock attempt fails until released.
function storeLockedFromStart(stored: Record<string, unknown>) {
	const backend = new InMemoryAuthStorageBackend();
	backend.withLock(() => ({ result: undefined, next: JSON.stringify(stored) }));
	const lock = { held: true };
	const busy = () => new CredentialStoreBusyError("auth.json", 1_000);
	const storage = AuthStorage.fromStorage({
		withLock: (fn) => {
			if (lock.held) throw busy();
			return backend.withLock(fn);
		},
		withLockAsync: async (fn, options) => {
			if (lock.held) throw busy();
			return backend.withLockAsync(fn, options);
		},
	});
	return { storage, lock };
}

function seedHistory(harness: Harness, totalTokens: number): void {
	const model = harness.getModel();
	for (const label of ["one", "two", "three", "recent"]) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(8000, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(8000, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: totalTokens, totalTokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function runPath(
	path: Path,
	compactionModel: string | undefined,
	prepare?: (harness: Harness) => void,
	harnessOptions: Partial<HarnessOptions> = {},
) {
	const scenario = SCENARIOS[path];
	const harness = await createHarness({
		models: [SESSION_MODEL, SUMMARY_MODEL],
		tools: [],
		settings: { compaction: compactionModel ? { model: compactionModel } : {} },
		extensionFactories: [compactionExtension],
		...harnessOptions,
	});
	prepare?.(harness);
	if (scenario.mode) await harness.session.bindExtensions({ mode: scenario.mode, shutdownHandler: () => {} });
	seedHistory(harness, scenario.seedTokens);

	const calls: RecordedCall[] = [];
	let signalSummary: () => void = () => {};
	const firstSummary = new Promise<void>((resolve) => {
		signalSummary = resolve;
	});
	harness.setResponses(
		Array.from({ length: 6 }, () => (context: Context, _options: unknown, _state: unknown, model: { id: string }) => {
			const summary = SUMMARY_REQUEST.test(lastMessageText(context));
			calls.push({ model: model.id, summary });
			if (!summary) return fauxAssistantMessage(scenario.reply);
			signalSummary();
			return fauxAssistantMessage("Summary of the earlier work.");
		}),
	);

	await harness.session.prompt("continue");
	// Speculative and idle summaries run in the background after the turn; wait for the
	// summary request itself, bounded so a path that never summarizes fails instead of hanging.
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		firstSummary,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`no ${path} summary request`)), SETTLE_TIMEOUT_MS);
		}),
	]).finally(() => clearTimeout(timer));
	return { harness, calls };
}

describe("#830 compaction.model on a healthy provider", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each(["threshold", "speculative", "idle"] as const)(
		"summarizes %s compaction on the configured compaction.model",
		async (path) => {
			const { harness, calls } = await runPath(path, "faux/summary-model");
			harnesses.push(harness);

			expect(calls.filter((call) => call.summary).map((call) => call.model)).toContain("summary-model");
			expect(calls.filter((call) => call.summary && call.model !== "summary-model")).toEqual([]);
			expect(calls.filter((call) => !call.summary).map((call) => call.model)).toEqual(["session-model"]);
		},
	);

	it.each(["threshold", "speculative", "idle"] as const)(
		"keeps %s compaction on the session model when compaction.model is unset",
		async (path) => {
			const { harness, calls } = await runPath(path, undefined);
			harnesses.push(harness);

			expect(calls.filter((call) => call.summary).length).toBeGreaterThan(0);
			expect(calls.every((call) => call.model === "session-model")).toBe(true);
		},
	);

	it.each([
		{ name: "unknown", override: "faux/missing-model", reason: "unknown_model" },
		{ name: "without credentials", override: "noauth/summary-model", reason: "no_credentials" },
	])("falls back to the session model and logs why when the override is $name", async ({ override, reason }) => {
		const { harness, calls } = await runPath("threshold", override, (harness) =>
			registerSummaryProvider(harness, "noauth"),
		);
		harnesses.push(harness);

		expect(calls.filter((call) => call.summary).map((call) => call.model)).toEqual(["session-model"]);
		expect(fallbackLog(harness)).toEqual([
			expect.objectContaining({ level: "warn", model: override, reason, to: "faux/session-model" }),
		]);
	});

	it("keeps a stored override when the credential store was busy on its first read", async () => {
		const { storage, lock } = storeLockedFromStart({
			faux: { type: "api_key", key: "faux-key" },
			stored: { type: "api_key", key: "stored-key" },
		});
		const { harness, calls } = await runPath(
			"threshold",
			"stored/summary-model",
			(harness) => {
				registerSummaryProvider(harness, "stored");
				lock.held = false;
			},
			{ authStorage: storage },
		);
		harnesses.push(harness);

		expect(calls.filter((call) => call.summary).map((call) => call.model)).toEqual(["summary-model"]);
		expect(fallbackLog(harness)).toEqual([]);
	});
});
