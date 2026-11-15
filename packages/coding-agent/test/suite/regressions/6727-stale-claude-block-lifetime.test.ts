import { afterEach, describe, expect, it } from "vitest";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";
import { blocked, cleanupClaudeLimitRechecks, NOW, setup } from "../../support/claude-limit-recheck.ts";

afterEach(cleanupClaudeLimitRechecks);

describe("Claude recheck allowance belongs to an admitted person's run (senpi#6727)", () => {
	it.each(["custom", "user"] as const)(
		"does not probe an untried stale account for an automated %s follow-up inside a person's run",
		async (role) => {
			const firstStarted = Promise.withResolvers<void>();
			const finishFirst = Promise.withResolvers<void>();
			let calls = 0;
			const available = `follow-${role}-a`;
			const stale = `follow-${role}-b`;
			const { harness, attempts } = await setup([cliSlot(available), blocked(stale)], async (name) => {
				if (name !== available) return;
				if (++calls === 1) {
					firstStarted.resolve();
					await finishFirst.promise;
					return;
				}
				return "You've hit your limit · resets in 2 hours";
			});

			const person = harness.session.prompt("start a person's run");
			await firstStarted.promise;
			try {
				if (role === "custom") {
					await harness.session.sendCustomMessage(
						{ customType: "6727-in-run-follow-up", content: "automatic follow-up", display: false },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				} else {
					await harness.session.prompt("automatic follow-up", {
						source: "extension",
						streamingBehavior: "followUp",
					});
				}
			} finally {
				finishFirst.resolve();
			}
			await person;

			expect(attempts).toEqual([available, available]);
		},
	);

	it.each(["before_agent_start", "nextTurn"] as const)(
		"keeps the allowance for a custom message added through %s to the person's own batch",
		async (delivery) => {
			const message = { customType: "6727-person-batch", content: "prompt context", display: false };
			const { harness, attempts } = await setup([blocked(`batch-${delivery}`)], undefined, false, [
				(pi) => {
					if (delivery === "before_agent_start") {
						pi.on("before_agent_start", () => ({ message }));
					}
				},
			]);
			if (delivery === "nextTurn") {
				await harness.session.sendCustomMessage(message, { deliverAs: "nextTurn" });
			}

			await harness.session.prompt("try the blocked account");

			expect(attempts).toEqual([`batch-${delivery}`]);
			expect(harness.session.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ role: "custom", customType: message.customType })]),
			);
		},
	);

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
