import { afterEach, describe, expect, it } from "vitest";
import { blocked, cleanupClaudeLimitRechecks, NOW, setup } from "../../support/claude-limit-recheck.ts";

afterEach(cleanupClaudeLimitRechecks);

describe("Claude recheck allowance belongs to an admitted person's run (senpi#6727)", () => {
	it("does not probe an untried account on an automated wake after retry cancellation", async () => {
		const { harness, attempts } = await setup(
			[blocked("cancel-first"), blocked("cancel-untried")],
			(name) => (name === "cancel-first" ? "overloaded_error" : undefined),
			true,
		);
		await harness.authStorage.modify("anthropic-subscription", async (current) => {
			if (current?.type !== "oauth") throw new Error("Missing Claude credential");
			return { ...current, pinned: "cancel-first" };
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") harness.session.abortRetry();
		});

		await harness.session.prompt("try once");
		unsubscribe();
		expect(attempts).toEqual(["cancel-first"]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ finalError: "Retry cancelled" }]);

		await harness.session.sendCustomMessage(
			{ customType: "6727-cancel-wake", content: "automatic continuation", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		expect(attempts).toEqual(["cancel-first"]);
	});

	it("does not probe an untried account on an automated wake after required compaction blocks retry", async () => {
		let compactions = 0;
		const { harness, attempts } = await setup(
			[blocked("compact-first"), blocked("compact-untried")],
			(name) => (name === "compact-first" ? "overloaded_error" : undefined),
			true,
			[
				(pi) => {
					pi.on("session_before_compact", () => {
						compactions++;
						return { cancel: true };
					});
				},
			],
		);
		await harness.authStorage.modify("anthropic-subscription", async (current) => {
			if (current?.type !== "oauth") throw new Error("Missing Claude credential");
			return { ...current, pinned: "compact-first" };
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "auto_retry_start") return;
			harness.sessionManager.appendMessage({
				role: "user",
				content: "context ".repeat(150_000),
				timestamp: NOW,
			});
			harness.settingsManager.setCompactionEnabled(true);
		});

		await harness.session.prompt("try once");
		unsubscribe();
		expect(attempts).toEqual(["compact-first"]);
		expect(compactions).toBeGreaterThan(0);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, finalError: expect.stringMatching(/compaction/i) },
		]);
		harness.settingsManager.setCompactionEnabled(false);

		await harness.session.sendCustomMessage(
			{ customType: "6727-compaction-wake", content: "automatic continuation", display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		expect(attempts).toEqual(["compact-first"]);
	});

	it.each(["handled", "cancelled"] as const)("retains the provider hold when a person's input is %s", async (mode) => {
		const controller = new AbortController();
		const { harness, attempts } = await setup(
			[blocked(`hold-${mode}`)],
			() => "You've hit your limit · resets in 2 hours",
			false,
			[
				(pi) => {
					pi.on("input", (event) => {
						if (event.text !== "discard this input") return;
						if (mode === "handled") return { action: "handled" };
						controller.abort();
					});
				},
			],
		);
		await harness.session.prompt("establish a provider hold");
		const discarded = harness.session.prompt("discard this input", { signal: controller.signal });
		if (mode === "handled") await discarded;
		else await expect(discarded).rejects.toThrow();

		await expect(harness.session.prompt("automated turn", { source: "extension" })).rejects.toMatchObject({
			name: "AccountUsageLimitError",
		});
		expect(attempts).toEqual([`hold-${mode}`]);
	});
});
