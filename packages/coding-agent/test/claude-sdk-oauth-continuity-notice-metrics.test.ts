import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CONTINUITY_DIAGNOSTIC_TYPE,
	ContinuityNoticeTracker,
	classifyContinuityReason,
	EXPECTED_REBUILD_REASONS,
} from "../src/modes/interactive/components/continuity-notice.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function noticeText(details: Record<string, unknown>): string {
	const notice = new ContinuityNoticeTracker().noticeFor(flattenMessage(details));
	expect(notice).toBeDefined();
	return stripAnsi(notice ?? "");
}

function flattenMessage(details: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "claude-sdk-oauth",
		provider: "claude-sdk-oauth",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		diagnostics: [{ type: CONTINUITY_DIAGNOSTIC_TYPE, timestamp: 1, details }],
	};
}

describe("continuity notice payload metrics", () => {
	beforeAll(() => initTheme("dark"));

	it("renders the re-sent payload size for a flatten notice", () => {
		const text = noticeText({
			kind: "flatten",
			reason: "transcript_missing",
			payloadBytes: 214_328,
			collapsedDirectives: 4,
		});

		expect(text).toContain("209.3KB");
	});

	it("renders the collapsed directive count for a flatten notice", () => {
		const text = noticeText({
			kind: "flatten",
			reason: "transcript_missing",
			payloadBytes: 214_328,
			collapsedDirectives: 4,
		});

		expect(text).toContain("4 duplicate ultrawork blocks collapsed");
	});

	it("omits the collapsed-directive clause when nothing was collapsed", () => {
		const text = noticeText({ kind: "flatten", reason: "registry_miss", payloadBytes: 1024, collapsedDirectives: 0 });

		expect(text).toContain("1.0KB");
		expect(text).not.toContain("collapsed");
	});

	it("keeps the existing notice text when metrics are absent", () => {
		const text = noticeText({ kind: "flatten", reason: "transcript_missing" });

		expect(text).toContain("Session continuity lost");
		expect(text).toContain("transcript_missing");
		expect(text).not.toContain("KB");
	});
});

describe("continuity reason classification", () => {
	beforeAll(() => initTheme("dark"));

	it("pins the expected-rebuild reason set", () => {
		expect([...EXPECTED_REBUILD_REASONS]).toEqual([
			"tainted_compaction",
			"model_changed",
			"branch_diverged",
			"tainted_fork",
			"cross_root_unsupported",
		]);
	});

	it("classifies every expected rebuild reason as expected-rebuild", () => {
		for (const reason of EXPECTED_REBUILD_REASONS) {
			expect(classifyContinuityReason(reason)).toBe("expected-rebuild");
		}
	});

	it("keeps defect-shaped, unknown, and missing reasons as lost", () => {
		for (const reason of [
			"assistant_rewritten",
			"registry_miss",
			"sent_stream_diverged",
			"resume_initialization_failed",
			"totally_unknown_reason",
			undefined,
		]) {
			expect(classifyContinuityReason(reason)).toBe("lost");
		}
	});
});

describe("continuity notice rebuild wording", () => {
	beforeAll(() => initTheme("dark"));

	it("labels an expected rebuild as a rebuilt context, not lost continuity", () => {
		const text = noticeText({ kind: "flatten", reason: "tainted_compaction", payloadBytes: 1024 });

		expect(text).toContain("Session context rebuilt (tainted_compaction)");
		expect(text).not.toContain("Session continuity lost");
	});

	it("keeps the lost wording for defect-shaped reasons", () => {
		const text = noticeText({ kind: "flatten", reason: "registry_miss", payloadBytes: 1024 });

		expect(text).toContain("Session continuity lost - resent the full conversation (registry_miss)");
	});

	it("appends the cache cost when the diagnostic carries cache metrics", () => {
		const text = noticeText({
			kind: "flatten",
			reason: "registry_miss",
			payloadBytes: 1024,
			cacheRead: 25_458,
			cacheWrite: 41_516,
		});

		expect(text).toContain("- sent 1.0KB - cache read 25.4K / write 41.5K tokens");
	});

	it("appends only the known cache side", () => {
		const text = noticeText({
			kind: "flatten",
			reason: "transcript_missing",
			payloadBytes: 1024,
			cacheWrite: 397_299,
		});

		expect(text).toContain("cache write 397.2K tokens");
		expect(text).not.toContain("cache read");
	});
});
