import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createHarness } from "../harness.ts";
import { nextSessionEvent } from "../lifecycle-test-harness.ts";

// senpi#3864: a settlement-deferred turn owns the epoch before the previous run can look done.
it("keeps a continuation scheduled at agent_settled running until its final reply", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const timeout = AbortSignal.timeout(10_000);
	timeout.addEventListener("abort", () => entered.reject(timeout.reason), { once: true });
	let continued = false;
	const h = await createHarness({
		persistSession: true,
		extensionFactories: [
			(pi) => {
				pi.on("agent_settled", () => {
					if (continued) return;
					continued = true;
					pi.sendMessage(
						{ customType: "goal-continuation", content: "Finish the remaining work.", display: false },
						{ triggerTurn: true },
					);
				});
			},
		],
	});
	let run: Promise<void> | undefined;
	try {
		expect(h.session.lifecycle).toBeDefined();
		await h.session.bindExtensions({ mode: "rpc" });
		h.setResponses([
			fauxAssistantMessage("Intermediate reply."),
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("Final reply.");
			},
		]);
		const idle = nextSessionEvent(h, (event) => event.type === "agent_idle");
		run = h.session.prompt("Finish both steps.");
		void run.catch(entered.reject);
		await entered.promise;
		expect(h.session.lifecycle).toMatchObject({ state: "running" });
		expect(
			h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
		).toHaveLength(0);
		release.resolve();
		await run;
		await idle;
		expect(
			h.events.filter((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done"),
		).toHaveLength(1);
	} finally {
		release.resolve();
		try {
			await run;
		} finally {
			h.cleanup();
		}
	}
});
