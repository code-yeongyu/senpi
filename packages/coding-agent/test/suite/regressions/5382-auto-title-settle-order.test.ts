import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { createAutoTitleHarness, createDeferred, waitForSessionName } from "../../agent-session-auto-title-helpers.ts";
import type { Harness } from "../harness.ts";

/**
 * senpi#5382: the auto-title reply and whatever a host or background job does once the session is idle are independent
 * inputs. Each case answers the title as late as the engine allows: it holds the reply until the host has acted when the
 * title is requested after `agent_idle`, and answers at once when the engine waits on it before going idle.
 */
describe("regression #5382: the auto-title has one place in the stream", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function titleAgainstHostAct(hostAct: (harness: Harness, api: ExtensionAPI) => void): Promise<string[]> {
		let api: ExtensionAPI | undefined;
		const harness = await createAutoTitleHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		let idle = false;
		harness.session.subscribe((event) => {
			if (event.type === "agent_idle") idle = true;
		});
		const hostActed = createDeferred<void>();
		harness.setResponses([
			fauxAssistantMessage("turn complete"),
			async () => {
				if (idle) await hostActed.promise;
				return fauxAssistantMessage("<title>QA session</title>");
			},
		]);
		if (api === undefined) throw new Error("extension did not load");

		const named = waitForSessionName(harness);
		await harness.session.prompt("write a file");
		hostAct(harness, api);
		hostActed.resolve();
		await named;

		return harness.events
			.map((event) => (event.type === "entry_appended" ? `entry_appended:${event.entry.type}` : event.type))
			.filter((type) =>
				["session_info_changed", "agent_settled", "agent_idle", "queue_update", "entry_appended:custom"].includes(
					type,
				),
			);
	}

	it("emits session_info_changed before the settle, ahead of a host's clear_queue at idle (E09)", async () => {
		const order = await titleAgainstHostAct((harness) => harness.session.clearQueue());

		expect(order).toEqual(["session_info_changed", "agent_settled", "agent_idle", "queue_update"]);
	});

	it("emits session_info_changed before the settle, ahead of an entry appended at idle (E16)", async () => {
		const order = await titleAgainstHostAct((_harness, api) => api.appendEntry("eq-background-done", { done: true }));

		expect(order).toEqual(["session_info_changed", "agent_settled", "agent_idle", "entry_appended:custom"]);
	});

	it("does not title a run the user aborted", async () => {
		const harness = await createAutoTitleHarness();
		harnesses.push(harness);
		const turnHeld = createDeferred<void>();
		const turnStarted = createDeferred<void>();
		harness.setResponses([
			async () => {
				turnStarted.resolve();
				await turnHeld.promise;
				return fauxAssistantMessage("never seen");
			},
		]);

		const running = harness.session.prompt("write a file");
		await turnStarted.promise;
		await harness.session.abort();
		turnHeld.resolve();
		await running;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(harness.eventsOfType("session_info_changed")).toEqual([]);
	});
});
