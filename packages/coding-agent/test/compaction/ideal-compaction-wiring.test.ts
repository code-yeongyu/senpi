import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { resolveCompactionSettings } from "../../src/core/compaction-settings-resolver.ts";
import {
	admitContextToolResult,
	admitContextToolResults,
	estimateToolResultOmissionTokens,
	resolveBeforeAgentStartMessage,
	resolveCompactionGeometry,
	resolveMultipartRetainedBound,
	resolveReminderSystemPrompt,
	shouldDeferGraceBand,
} from "../../src/core/extensions/builtin/compaction/orchestration.ts";
import { TOOL_ADMISSION_MARKER_PREFIX } from "../../src/core/extensions/builtin/compaction/tool-admission.ts";

let admissionDir: string;
let shortAdmissionDir: string;

beforeEach(() => {
	admissionDir = mkdtempSync(join(tmpdir(), "wiring-admission-"));
	shortAdmissionDir = mkdtempSync(join(tmpdir(), "x-"));
	rmSync(join(tmpdir(), "senpi-tool-spill"), { recursive: true, force: true });
});

afterEach(() => {
	rmSync(admissionDir, { recursive: true, force: true });
	rmSync(shortAdmissionDir, { recursive: true, force: true });
});

describe("ideal compaction extension wiring decisions", () => {
	it("defers an in-flight compaction inside the grace band", () => {
		expect(
			shouldDeferGraceBand({
				tokens: 82_000,
				thresholdTokens: 80_000,
				leadTokens: 10_000,
				contextWindow: 100_000,
				reserveTokens: 10_000,
				compactionInFlight: true,
				graceBandEnabled: true,
			}),
		).toBe(true);
	});

	it("blocks past the grace cap or when the setting is disabled", () => {
		const base = {
			tokens: 91_000,
			thresholdTokens: 80_000,
			leadTokens: 10_000,
			contextWindow: 100_000,
			reserveTokens: 10_000,
			compactionInFlight: true,
			graceBandEnabled: true,
		};
		expect(shouldDeferGraceBand(base)).toBe(false);
		expect(shouldDeferGraceBand({ ...base, tokens: 82_000, graceBandEnabled: false })).toBe(false);
	});

	it("delivers a reminder through the system-prompt seam on an ordinary turn", () => {
		expect(resolveBeforeAgentStartMessage({ message: undefined, reminder: "budget reminder" })).toBeUndefined();
		expect(resolveReminderSystemPrompt({ systemPrompt: "base", reminder: "budget reminder" })).toBe(
			"base\n\nbudget reminder",
		);
	});

	it("merges a simultaneous reminder into the pending restoration message", () => {
		const restoration = { customType: "compaction-restoration", content: "restore checkpoint", display: false };
		expect(resolveBeforeAgentStartMessage({ message: restoration, reminder: "budget reminder" })).toEqual({
			...restoration,
			content: "restore checkpoint\n\nbudget reminder",
		});
		expect(
			resolveBeforeAgentStartMessage({
				message: restoration,
				reminder: "budget reminder",
				reminderEnabled: false,
			}),
		).toEqual(restoration);
	});

	it("clamps one configured lead for trigger, grace, and reminder geometry", () => {
		const base = { contextWindow: 200_000, lastYield: undefined };
		const low = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1 },
		});
		const high = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, speculativeLeadTokens: 1_000_000 },
		});
		const automatic = resolveCompactionGeometry({
			...base,
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		});
		expect(automatic).toMatchObject({ thresholdTokens: 140_000, leadTokens: 17_500 });
		expect(low).toMatchObject({ thresholdTokens: 140_000, leadTokens: 8192 });
		expect(high).toMatchObject({ thresholdTokens: 140_000, leadTokens: 32_768 });
	});

	it("falls back to safe defaults for malformed JSON settings fields", () => {
		const settings = resolveCompactionSettings({ keepRecentTokens: "bad" as never, speculativeFraction: Number.NaN });
		expect(settings.keepRecentTokens).toBe(20_000);
		expect(settings.speculativeFraction).toBe(0.75);
	});

	it("caps multipart tool text blocks with one aggregate budget and preserves images", () => {
		const cap = 10_000;
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "tool-1",
				toolName: "test",
				content: [
					{ type: "text" as const, text: "a".repeat(cap * 8) },
					image,
					{ type: "text" as const, text: "b".repeat(cap * 8) },
				],
				isError: false,
				timestamp: 0,
			},
		];
		const projected = admitContextToolResults(messages, 200_000, true, cap)[0];
		const projectedContent = (projected as { content: Array<{ type: string; text?: string }> }).content;
		const text = projectedContent
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
		expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBeLessThanOrEqual(cap);
		expect(projectedContent).toContainEqual(image);
	});

	it("emits a trailing omission line for dropped multipart text", () => {
		const cap = 10_000;
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "tool-2",
				toolName: "test",
				isError: false,
				timestamp: 0,
				content: [
					{ type: "text" as const, text: "a".repeat(cap * 8) },
					{ type: "text" as const, text: "b".repeat(cap * 8) },
					{ type: "text" as const, text: "c".repeat(cap * 8) },
				],
			},
		];
		const projected = admitContextToolResults(messages, 200_000, true, cap)[0] as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = projected.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		expect(text).toContain("tool-result admission:");
		expect(text).toContain("full outputs at:");
		expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBeLessThanOrEqual(cap);
	});

	it.each(["short", "long"])("keeps tiny-cap omission metadata reachable (%s path)", (pathKind) => {
		const spillDir = pathKind === "short" ? shortAdmissionDir : admissionDir;
		const probeParts = [
			{ tokens: 80_000, path: join(spillDir, "tool-result-probe-a.txt") },
			{ tokens: 80_000, path: join(spillDir, "tool-result-probe-b.txt") },
		];
		const cap = Math.max(1, estimateToolResultOmissionTokens(probeParts) - 1);
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "tiny",
				toolName: "test",
				isError: false,
				timestamp: 0,
				content: [
					{ type: "text" as const, text: "a".repeat(10_000) },
					{ type: "text" as const, text: "b".repeat(10_000) },
				],
			},
		];
		const projected = admitContextToolResults(messages, 1_200, true, cap, spillDir)[0] as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = projected.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		expect(text).toContain("tool-result admission:");
		expect(text.match(/tool-result-[^\s;]+/g)).toHaveLength(2);
		expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBeGreaterThan(cap);
	});

	it("returns an empty plus fitting text block unchanged", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "fits",
				toolName: "test",
				isError: false,
				timestamp: 0,
				content: [
					{ type: "text" as const, text: "" },
					{ type: "text" as const, text: "a".repeat(8_191) },
				],
			},
		];
		const projected = admitContextToolResults(messages, 163_840, true, 8_192, shortAdmissionDir)[0];
		expect(projected).toEqual(messages[0]);
	});

	it("counts empty text blocks in the exact multipart bound", () => {
		const cap = 60;
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "empty-first",
				toolName: "test",
				isError: false,
				timestamp: 0,
				content: [
					{ type: "text" as const, text: "" },
					{ type: "text" as const, text: "a".repeat(10_000) },
					{ type: "text" as const, text: "b".repeat(10_000) },
				],
			},
		];
		const projected = admitContextToolResults(messages, 1_200, true, cap, shortAdmissionDir)[0] as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = projected.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		const omission = text.slice(text.indexOf("[tool-result admission:"));
		expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBeLessThanOrEqual(
			resolveMultipartRetainedBound(cap, omission, 3),
		);
	});

	it("keeps the 13-part reviewer repro within the amended bound", () => {
		const cap = 1_000;
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "thirteen",
				toolName: "test",
				isError: false,
				timestamp: 0,
				content: Array.from({ length: 13 }, (_, index) => ({
					type: "text" as const,
					text: String.fromCharCode(97 + index).repeat(8_100),
				})),
			},
		];
		const projected = admitContextToolResults(messages, 20_000, true, cap)[0] as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = projected.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
		const omission = text.slice(text.indexOf("[tool-result admission:"));
		expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBeLessThanOrEqual(
			resolveMultipartRetainedBound(cap, omission, 13),
		);
	});

	it.each([60, 200, 1000, 10000])("keeps aggregate admission bounded at cap %i across oversized parts", (cap) => {
		for (let count = 1; count <= 4; count++) {
			rmSync(admissionDir, { recursive: true, force: true });
			mkdirSync(admissionDir, { recursive: true });
			const messages = [
				{
					role: "toolResult" as const,
					toolCallId: `tool-${cap}-${count}`,
					toolName: "test",
					isError: false,
					timestamp: 0,
					content: Array.from({ length: count }, (_, index) => ({
						type: "text" as const,
						text: String.fromCharCode(97 + index).repeat(cap * 8 + 100),
					})),
				},
			];
			const spillRoot = join(tmpdir(), "senpi-tool-spill");
			rmSync(spillRoot, { recursive: true, force: true });
			mkdirSync(spillRoot, { recursive: true });
			const projected = admitContextToolResults(messages, Math.max(1, cap * 20), true, cap)[0] as {
				content: Array<{ type: string; text?: string }>;
			};
			const text = projected.content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
			const expectedPaths = readdirSync(spillRoot).map((name) => join(spillRoot, name));
			for (const path of expectedPaths) expect(text).toContain(path);
			const omission = text.slice(text.indexOf("[tool-result admission:"));
			expect(estimateTokens({ role: "user", content: text, timestamp: 0 })).toBeLessThanOrEqual(
				resolveMultipartRetainedBound(cap, omission, count),
			);
		}
	});

	it("bypasses admission when an exact marker line sits inside the output", () => {
		const marker = `${TOOL_ADMISSION_MARKER_PREFIX} kept 10 of ~99 tokens; full output at /tmp/x.txt - read it with the read tool if needed]`;
		const marked = `head\n${marker}\ntail`;
		expect(admitContextToolResult(marked, 100_000, "/tmp/spill")).toEqual({ text: marked, admitted: false });
	});
});
