import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
};

/**
 * Legacy footer accumulation loop (footer.ts pre-Todo-2). Kept here as the
 * reference implementation: totals iterate ALL entries, not branch-scoped.
 */
function legacyTotals(session: SessionManager): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		latestCacheHitRate: undefined,
	};
	for (const entry of session.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			totals.input += entry.message.usage.input;
			totals.output += entry.message.usage.output;
			totals.cacheRead += entry.message.usage.cacheRead;
			totals.cacheWrite += entry.message.usage.cacheWrite;
			totals.cost += entry.message.usage.cost.total;

			const latestPromptTokens =
				entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
			totals.latestCacheHitRate =
				latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
		}
	}
	return totals;
}

function assistantMsgWithUsage(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number;
}) {
	const msg = assistantMsg("hi");
	msg.usage = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costTotal },
	};
	return msg;
}

describe("SessionManager.getUsageTotals()", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sm-usage-totals-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("matches the legacy accumulation loop on an empty session", () => {
		const session = SessionManager.inMemory();
		expect(session.getUsageTotals()).toEqual(legacyTotals(session));
	});

	it("matches the legacy accumulation loop incrementally", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hello"));
		expect(session.getUsageTotals()).toEqual(legacyTotals(session));

		session.appendMessage(
			assistantMsgWithUsage({ input: 100, output: 50, cacheRead: 20, cacheWrite: 10, costTotal: 0.5 }),
		);
		expect(session.getUsageTotals()).toEqual(legacyTotals(session));

		session.appendMessage(userMsg("again"));
		session.appendMessage(assistantMsgWithUsage({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0, costTotal: 0 }));
		// Last assistant message has zero prompt tokens -> latestCacheHitRate undefined.
		expect(session.getUsageTotals()).toEqual(legacyTotals(session));
		expect(session.getUsageTotals().latestCacheHitRate).toBeUndefined();

		session.appendMessage(
			assistantMsgWithUsage({ input: 200, output: 80, cacheRead: 100, cacheWrite: 50, costTotal: 1.25 }),
		);
		expect(session.getUsageTotals()).toEqual(legacyTotals(session));
	});

	it("totals iterate ALL entries, not branch-scoped", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("one"));
		session.appendMessage(
			assistantMsgWithUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costTotal: 0.1 }),
		);
		session.appendMessage(userMsg("two"));
		const beforeInput = session.getUsageTotals().input;

		// Rewind the leaf; entries stay in the session and must still be counted.
		const entries = session.getEntries();
		session.branch(entries[0].id);
		session.appendMessage(userMsg("two-alt"));
		session.appendMessage(
			assistantMsgWithUsage({ input: 20, output: 5, cacheRead: 0, cacheWrite: 0, costTotal: 0.2 }),
		);

		expect(session.getUsageTotals().input).toBe(beforeInput + 20);
		expect(session.getUsageTotals()).toEqual(legacyTotals(session));
	});

	it("recomputes from scratch on setSessionFile", () => {
		const session = SessionManager.create(dir, dir);
		session.appendMessage(userMsg("hello"));
		session.appendMessage(
			assistantMsgWithUsage({ input: 42, output: 7, cacheRead: 3, cacheWrite: 1, costTotal: 0.01 }),
		);
		const file = session.getSessionFile()!;

		const reopened = SessionManager.inMemory();
		reopened.setSessionFile(file);
		expect(reopened.getUsageTotals()).toEqual(legacyTotals(reopened));
		expect(reopened.getUsageTotals().input).toBe(42);
	});

	it("resets totals on newSession", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(
			assistantMsgWithUsage({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costTotal: 0.3 }),
		);
		session.newSession();
		expect(session.getUsageTotals()).toEqual(legacyTotals(session));
		expect(session.getUsageTotals()).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			latestCacheHitRate: undefined,
		});
	});
});
