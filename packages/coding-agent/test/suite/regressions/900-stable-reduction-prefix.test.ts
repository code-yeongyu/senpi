import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompactionContext } from "../../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import { createEmergencyPruneLatch } from "../../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { estimateTotalTokens } from "../../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { OPENAI_NATIVE_LEGACY_MODEL } from "../../compaction/openai-remote-test-models.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const stateType = "senpi.context-reduction.v1";
const window = 100_000;
type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];

afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});

function assistant(id: number, name?: string, tokens = 0): AssistantMessage {
	return {
		role: "assistant",
		content: name
			? [{ type: "toolCall", id: `call-${id}`, name, arguments: { path: `file-${id}` } }]
			: [{ type: "text", text: "answer ".repeat(Math.ceil((tokens * 4) / 7)) }],
		api: "faux-completion",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: name ? "toolUse" : "stop",
		timestamp: id,
	};
}

function pair(id: number, name = "write", tokens = 900): StoredMessage[] {
	return [
		assistant(id, name),
		{
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: name,
			content: [{ type: "text", text: `${id}: ${"data ".repeat(Math.ceil((tokens * 4) / 5))}` }],
			isError: false,
			timestamp: id,
		},
	];
}

function history(clearableName = "write"): StoredMessage[] {
	const messages: StoredMessage[] = [{ role: "user", content: "context ".repeat(16_000), timestamp: 0 }];
	messages.push(assistant(1, undefined, 1_600));
	for (let id = 2; id < 22; id++) {
		messages.push(...pair(id, clearableName === "read" ? "read" : id % 3 === 0 ? "eval" : clearableName));
	}
	messages.push(assistant(22, undefined, 1_600));
	messages.push({ role: "user", content: "Continue.", timestamp: 23 });
	return messages;
}

async function harness(options: { maxTokens?: number; sessionManager?: SessionManager; siblingOf?: Harness } = {}) {
	const value = await createHarness({
		models: [{ id: "frontier", contextWindow: window, maxTokens: options.maxTokens ?? 4_000 }],
		settings: { compaction: { enabled: false, toolAdmissionEnabled: false, restorationEnabled: false } },
		extensionFactories: [compactionExtension],
		persistSession: true,
		...options,
	});
	harnesses.push(value);
	await value.session.bindExtensions({});
	return value;
}

function append(h: Harness, messages: StoredMessage[]) {
	for (const message of messages) h.sessionManager.appendMessage(message);
}

function render(h: Harness) {
	return h.getExtensionRunner().emitContext(h.sessionManager.buildSessionContext().messages);
}

function frontierRecords(h: Harness) {
	return h.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === stateType);
}

function bytes(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// #900: prompt-byte stability must be observed after all three reducers and the context hook.
describe("stable request-local reduction prefix", () => {
	it.each(["write", "read"])("keeps every previously sent byte until a block step with %s results", async (name) => {
		const h = await harness();
		vi.spyOn(h.session, "getContextUsage").mockReturnValue({ tokens: 55_000, contextWindow: window, percent: 55 });
		append(h, history(name));
		let previous = await render(h);
		let records = frontierRecords(h).length;
		let stable = 0;
		let steps = 0;
		for (let turn = 0; turn < 40; turn++) {
			append(h, pair(100 + turn, name === "read" ? "read" : turn % 4 === 0 ? "read" : "eval", 300));
			const current = await render(h);
			const nextRecords = frontierRecords(h).length;
			if (nextRecords === records) {
				expect(bytes(current.slice(0, previous.length))).toBe(bytes(previous));
				stable++;
			} else {
				expect(bytes(current.slice(0, previous.length))).not.toBe(bytes(previous));
				steps++;
			}
			previous = current;
			records = nextRecords;
		}
		expect(stable).toBeGreaterThan(30);
		expect(steps).toBeGreaterThan(0);
		expect(steps).toBeLessThan(4);
	});

	it("bypasses reduction on native and append-only paths even with an engaged latch", async () => {
		const h = await harness();
		const messages = history();
		const ctx = h.getExtensionRunner().createContext();
		for (const lane of ["native", "external", "append-only"]) {
			const state = { engaged: true, cutIndex: 5, prefixHash: "already-engaged" };
			const outgoing = buildCompactionContext({
				event: { type: "context", messages },
				ctx: { ...ctx, model: lane === "native" ? OPENAI_NATIVE_LEGACY_MODEL : h.getModel() },
				contextWindow: window,
				promptContextWindow: window,
				contextReductionState: state,
				toolAdmissionEnabled: false,
				breakerFallback: true,
				laneOwnsCompaction: lane === "external",
				appendOnlyTranscript: lane === "append-only",
				emergencyPruneLatch: createEmergencyPruneLatch(),
			});
			expect(bytes(outgoing)).toBe(bytes(convertToLlm(messages)));
			expect(state).toEqual({ engaged: true, cutIndex: 5, prefixHash: "already-engaged" });
		}
	});

	it("uses unreduced history and never alternates with the previous request usage", async () => {
		const h = await harness();
		const usage = vi.spyOn(h.session, "getContextUsage");
		append(h, history());
		const shapes = new Set<string>();
		for (const tokens of [49_000, 51_000, 20_000, 50_001, 0, 49_999]) {
			usage.mockReturnValue({ tokens, contextWindow: window, percent: tokens / 1_000 });
			shapes.add(JSON.stringify(await render(h)));
		}
		expect(shapes.size).toBe(1);
		expect([...shapes][0]).not.toBe(JSON.stringify(convertToLlm(h.sessionManager.buildSessionContext().messages)));
	});

	it("keeps the latch when the model window grows until history resets", async () => {
		const h = await harness();
		const usage = vi.spyOn(h.session, "getContextUsage");
		usage.mockReturnValue({ tokens: 55_000, contextWindow: window, percent: 55 });
		append(h, history());
		const previous = await render(h);
		usage.mockReturnValue({ tokens: 10_000, contextWindow: 200_000, percent: 5 });
		expect(bytes(await render(h))).toBe(bytes(previous));
	});

	it("forces a ceiling step below the block budget before the output-reserved window overflows", async () => {
		const h = await harness({ maxTokens: 48_000 });
		append(h, history());
		await render(h);
		expect(frontierRecords(h).length).toBeGreaterThan(0);
		const initialRecords = frontierRecords(h).length;
		// Less than the 10k block budget, but near the 52k prompt window.
		append(h, [...pair(200, "write", 1_000), ...pair(201, "write", 1_000), ...pair(202, "write", 1_000)]);
		const outgoing = await render(h);
		expect(frontierRecords(h).length).toBeGreaterThan(initialRecords);
		expect(estimateTotalTokens(outgoing)).toBeLessThan(52_000);
	});

	it("restores exactly the same prefix from a reopened session after tail growth", async () => {
		const h = await harness();
		append(h, history());
		await render(h);
		append(h, pair(300, "read", 400));
		const previous = await render(h);
		const file = h.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected persisted session");
		const reopened = SessionManager.open(file);
		const resumed = await harness({ sessionManager: reopened, siblingOf: h });
		expect(bytes(await render(resumed))).toBe(bytes(previous));
		expect(frontierRecords(resumed).length).toBe(frontierRecords(h).length);
	});

	it("resets on accepted compaction and branch navigation but not rejected compaction", async () => {
		const h = await harness();
		append(h, history());
		const previous = await render(h);
		const runner = h.getExtensionRunner();
		await runner.emit({
			type: "session_compact",
			reason: "manual",
			requestId: "rejected",
			accepted: false,
			rejectionCause: "cancelled-by-extension",
			fromExtension: false,
			willRetry: false,
		});
		expect(JSON.stringify(await render(h))).toBe(JSON.stringify(previous));
		const oldLeafId = h.sessionManager.getLeafId();
		h.sessionManager.resetLeaf();
		append(h, [{ role: "user", content: "New branch.", timestamp: 400 }]);
		await runner.emit({ type: "session_tree", oldLeafId, newLeafId: h.sessionManager.getLeafId() });
		expect(await render(h)).toEqual(convertToLlm(h.sessionManager.buildSessionContext().messages));
		append(h, history());
		await render(h);
		const kept = h.sessionManager.appendMessage({ role: "user", content: "Kept.", timestamp: 500 });
		const compactId = h.sessionManager.appendCompaction("Summary.", kept, 60_000);
		const compactionEntry = h.sessionManager.getEntry(compactId);
		if (compactionEntry?.type !== "compaction") throw new Error("Expected compaction");
		await runner.emit({
			type: "session_compact",
			reason: "manual",
			requestId: "accepted",
			accepted: true,
			compactionEntry,
			fromExtension: true,
			willRetry: false,
		});
		expect(await render(h)).toEqual(convertToLlm(h.sessionManager.buildSessionContext().messages));
		const records = frontierRecords(h);
		expect(records.length).toBeGreaterThan(0);
	});
});
