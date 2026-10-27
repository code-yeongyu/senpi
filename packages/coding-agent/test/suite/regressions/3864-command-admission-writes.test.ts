import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#4231 review: a registered slash command's human admission is durable only when its run opens an epoch.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

const commands: ExtensionFactory = (pi) => {
	pi.registerCommand("go", { description: "starts a run", handler: async () => pi.sendUserMessage("hello") });
	pi.registerCommand("noop", { description: "starts no run", handler: async () => {} });
};

async function harness(turns: number, replies = turns): Promise<Harness> {
	const h = await createBoundLifecycleHarness({ extensionFactories: [commands] });
	harnesses.push(h);
	h.setResponses(Array.from({ length: replies }, (_, index) => fauxAssistantMessage(`Reply ${index + 1}.`)));
	for (let index = 0; index < turns; index++) await runToAgentIdle(h, () => h.session.prompt(`Request ${index}`));
	return h;
}

function lifecycleRecords(h: Harness) {
	return h.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => {
			const data = (entry as { data: { state: string; epoch: number; runActive?: boolean } }).data;
			return { state: data.state, epoch: data.epoch, runActive: data.runActive === true };
		});
}

it("writes only the epoch's opening and seal for a command that starts a run", async () => {
	const h = await harness(1, 2);
	const before = lifecycleRecords(h).length;

	await runToAgentIdle(h, () => h.session.prompt("/go"));

	const epoch = h.session.lifecycle.epoch;
	expect(lifecycleRecords(h).slice(before)).toEqual([
		{ state: "running", epoch, runActive: true },
		{ state: "done", epoch, runActive: false },
	]);
});

it.each([0, 1])("writes no durable record for a command that starts no run after %i turns", async (turns) => {
	const h = await harness(turns);
	const before = lifecycleRecords(h);
	const { state, epoch, seq } = h.session.lifecycle;

	await h.session.prompt("/noop");

	expect(lifecycleRecords(h)).toEqual(before);
	expect(h.session.lifecycle).toMatchObject({ state, epoch, seq });
});

it("measures durable lifecycle writes per 100 registered slash commands", async () => {
	const noRun = await harness(1);
	const noRunBefore = lifecycleRecords(noRun).length;
	for (let index = 0; index < 100; index++) await noRun.session.prompt("/noop");

	const startsRun = await harness(1, 101);
	const startsRunBefore = lifecycleRecords(startsRun).length;
	for (let index = 0; index < 100; index++) await runToAgentIdle(startsRun, () => startsRun.session.prompt("/go"));

	expect({
		noRun: lifecycleRecords(noRun).length - noRunBefore,
		startsRun: lifecycleRecords(startsRun).length - startsRunBefore,
	}).toEqual({ noRun: 0, startsRun: 200 });
});
