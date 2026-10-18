/**
 * senpi#3370: subscription limit windows read from what the providers send. The Codex case is a live
 * response's headers (sanitized fixture); the stream event and Claude shapes follow the providers' own
 * clients. A window the provider did not report is absent, never 0%.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	claudeWindowsFromHeaders,
	claudeWindowsFromSdkEvent,
	codexWindowsFromHeaders,
	windowLabel,
} from "../../../src/core/subscription-limits/limit-windows.ts";

const fixture = JSON.parse(
	readFileSync(join(__dirname, "../../fixtures/subscription-limits/codex-response-headers.json"), "utf8"),
) as { headers: Record<string, string> };

describe("subscription limit windows (senpi#3370)", () => {
	it("reads the live Codex response: a weekly primary window, and no secondary (all zero, empty reset)", () => {
		expect(codexWindowsFromHeaders(fixture.headers)).toEqual([
			{
				id: "codex:primary",
				label: "7d",
				windowMinutes: 10080,
				usedPercent: 99,
				resetsAt: new Date(1792555751 * 1000).toISOString(),
			},
		]);
	});

	it("reads every metered limit family and is case-insensitive", () => {
		const windows = codexWindowsFromHeaders({
			"X-Codex-Primary-Used-Percent": "12.5",
			"x-codex-primary-window-minutes": "300",
			"x-codex-other-primary-used-percent": "40",
			"x-codex-other-primary-window-minutes": "10080",
		});

		expect(windows.map((window) => [window.id, window.label, window.usedPercent])).toEqual([
			["codex:primary", "5h", 12.5],
			["codex_other:primary", "7d codex_other", 40],
		]);
	});

	it("reads Claude's unified headers (utilization is a 0-1 fraction)", () => {
		expect(
			claudeWindowsFromHeaders({
				"anthropic-ratelimit-unified-5h-utilization": "0.4237",
				"anthropic-ratelimit-unified-5h-reset": "1704069000",
				"anthropic-ratelimit-unified-7d-utilization": "0.05",
			}),
		).toEqual([
			{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 42.37, resetsAt: "2024-01-01T00:30:00.000Z" },
			{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 5 },
		]);
	});

	it("reads the Claude SDK rate_limit_event", () => {
		expect(
			claudeWindowsFromSdkEvent({
				type: "rate_limit_event",
				rate_limit_info: { rateLimitType: "seven_day_opus", utilization: 0.9, resetsAt: 1704069000 },
			}),
		).toEqual([
			{
				id: "claude:7d_opus",
				label: "7d opus",
				windowMinutes: 10080,
				usedPercent: 90,
				resetsAt: "2024-01-01T00:30:00.000Z",
			},
		]);
	});

	it("reports nothing, not 0%, when a response carries no window", () => {
		expect(codexWindowsFromHeaders({ "content-type": "text/event-stream" })).toEqual([]);
		expect(claudeWindowsFromHeaders({})).toEqual([]);
		expect(windowLabel(undefined, "primary")).toBe("primary");
	});
});
