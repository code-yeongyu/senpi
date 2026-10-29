import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

// senpi#4692: interruption can become known after the first wake gate, during auth admission.
it.each(["plain", "itemized", "producer-ticket"] as const)(
	"holds a %s send interrupted during admission and runs its start hook only on Resume",
	async (kind) => {
		// Given an ordinary session whose existing auth admission await is controlled by promises.
		let api: ExtensionAPI | undefined;
		let starts = 0;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("before_agent_start", () => {
						starts++;
					});
				},
			],
		});
		harnesses.push(h);
		await h.session.bindExtensions({ mode: "tui" });
		if (api === undefined) throw new Error("Extension API missing");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const modelRuntime = h.session.modelRuntime;
		const checkAuth = modelRuntime.checkAuth.bind(modelRuntime);
		vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValueOnce(false);
		vi.spyOn(modelRuntime, "checkAuth").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return checkAuth(...args);
		});
		const payload = "held-admission-payload";
		const message = { customType: "senpi-task:completed", content: payload, display: false };
		const ticket =
			kind === "producer-ticket"
				? h.session.workObligations.open("task:late-interruption", "background").ticket()
				: undefined;
		const send =
			kind === "plain"
				? h.session.sendCustomMessage(message, { triggerTurn: true })
				: api.sendMessage(message, {
						triggerTurn: true,
						...(ticket === undefined ? {} : { ticket }),
						items: [{ itemId: "late-item", producer: "task", content: payload }],
					});
		// Attach the rejection observer before opening the admission gate.
		const outcome = Promise.resolve(send).then(
			(receipt) => ({ receipt }),
			(error: unknown) => ({ error }),
		);

		// When the run becomes interrupted while admission is awaiting auth.
		await entered.promise;
		h.session["_lifecycleBinding"].controller.ledger.interrupted = true;
		release.resolve();
		expect(await outcome).not.toHaveProperty("error");
		expect(h.faux.state.callCount).toBe(0);
		expect(h.session.pausedNoticeCount).toBe(1);
		expect(
			h.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "engine-turn-start"),
		).toEqual([]);
		const heldStarts = starts;
		h.setResponses([fauxAssistantMessage("Resumed")]);
		await h.session.resumeSession();

		// Then the payload arrives exactly once; a speculative held turn ran no start hook.
		expect(h.faux.state.callCount).toBe(1);
		expect(h.session.messages.map(getMessageText).join("\n").split(payload)).toHaveLength(2);
		expect(h.session.pausedNoticeCount).toBe(0);
		expect({ heldStarts, starts }).toEqual({ heldStarts: 0, starts: 1 });
	},
);

it("retains the final hold check when interruption first arises inside a start hook", async () => {
	// Given a callback already executing under the existing extension admission contract.
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let starts = 0;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", async () => {
					starts++;
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "tui" });
	const send = h.session.sendCustomMessage(
		{ customType: "senpi-task:completed", content: "during-hook-payload", display: false },
		{ triggerTurn: true },
	);

	// When interruption becomes known only after the callback began.
	await entered.promise;
	h.session["_lifecycleBinding"].controller.ledger.interrupted = true;
	release.resolve();
	await send;

	// Then the callback is not undone, but the final guard prevents automatic execution.
	expect(starts).toBe(1);
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.pausedNoticeCount).toBe(1);
	h.setResponses([fauxAssistantMessage("Resumed after callback")]);
	await h.session.resumeSession();
	expect(starts).toBe(2);
	expect(h.faux.state.callCount).toBe(1);
	expect(h.session.messages.map(getMessageText).join("\n").split("during-hook-payload")).toHaveLength(2);
	expect(h.session.pausedNoticeCount).toBe(0);
});
