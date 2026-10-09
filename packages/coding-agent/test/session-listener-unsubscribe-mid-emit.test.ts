import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { startEndpoint } from "./helpers/session-control-fixture.ts";
import { createHarness } from "./suite/harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function subscribeUnsubscribingInsideEmitOf(
	subscribe: (listener: (event: AgentSessionEvent) => void) => () => void,
	type: AgentSessionEvent["type"],
): void {
	const unsubscribe = subscribe((event) => {
		if (event.type === type) unsubscribe();
	});
}

describe("AgentSession listeners that unsubscribe during an emit", () => {
	it("still deliver that event to the listener registered after them", async () => {
		const harness = await createHarness();
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("reply")]);
		await harness.session.bindExtensions({});
		const seen: string[] = [];
		subscribeUnsubscribingInsideEmitOf((listener) => harness.session.subscribe(listener), "agent_start");
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") seen.push(event.type);
		});

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(seen).toEqual(["agent_start"]);
	});

	it("still wake a control endpoint registered after them when the session goes idle", async () => {
		const harness = await createHarness({ persistSession: true });
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("reply")]);
		await harness.session.bindExtensions({});
		subscribeUnsubscribingInsideEmitOf((listener) => harness.session.subscribe(listener), "agent_idle");
		const fixture = await startEndpoint({ harness });
		cleanups.push(() => fixture.endpoint.dispose());
		const idle = fixture.nextWake("idle");

		await harness.session.prompt("hello");

		expect((await idle).reasons).toContain("idle");
	});
});
