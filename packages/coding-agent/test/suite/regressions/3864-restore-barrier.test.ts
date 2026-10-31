import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { nextSessionEvent } from "../lifecycle-test-harness.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#3864: persisted terminal state is not publishable until every producer rehydrates.
it("keeps the restore barrier armed until the last session_start handler re-registers work", async () => {
	let block = false;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const timeout = AbortSignal.timeout(10_000);
	timeout.addEventListener("abort", () => entered.reject(timeout.reason), { once: true });
	const fixture = await createIdentityHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					if (!block) return;
					entered.resolve();
					await release.promise;
					pi.events.emit("wake_source_state", { source: "restored-monitor", kind: "background", activeCount: 1 });
				});
			},
		],
	});
	let binding: Promise<void> | undefined;
	try {
		await fixture.session.bindExtensions({ mode: "rpc" });
		expect(fixture.session.lifecycle).toBeDefined();
		fixture.harness.setResponses([fauxAssistantMessage("Complete.")]);
		const idle = nextSessionEvent(fixture.harness, (event) => event.type === "agent_idle");
		await fixture.session.prompt("Finish this.");
		await idle;
		const completionId = fixture.session.lifecycle.completionId;
		await fixture.openSettled();
		const events: AgentSessionEvent[] = [];
		fixture.session.subscribe((event) => {
			events.push(event);
		});
		block = true;
		binding = fixture.session.bindExtensions({ mode: "rpc" });
		void binding.catch(entered.reject);
		await entered.promise;
		expect(fixture.session.lifecycle).toMatchObject({ restoring: true, completionId });
		expect(events.filter((event) => event.type === "session_lifecycle")).toHaveLength(0);
		release.resolve();
		await binding;
		expect(fixture.session.lifecycle).toMatchObject({ restoring: false, state: "waiting_background" });
		expect(events.some((event) => event.type === "session_lifecycle" && event.lifecycle.state === "done")).toBe(
			false,
		);
	} finally {
		release.resolve();
		try {
			await binding;
		} finally {
			await fixture.cleanup();
		}
	}
});
