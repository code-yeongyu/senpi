import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CONTINUITY_DIAGNOSTIC_TYPE,
	ContinuityNoticeTracker,
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
		provider: "anthropic-subscription",
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
