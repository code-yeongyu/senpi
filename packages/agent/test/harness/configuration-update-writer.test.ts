import { createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { buildSessionContext } from "../../src/harness/session/context.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { Entry } from "../../src/harness/session/types.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

async function createHarness(session: Session): Promise<AgentHarness> {
	const { harness } = await AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("openai", "gpt-6-astra"),
	});
	return harness;
}

async function branchEntries(session: Session): Promise<Entry[]> {
	const leaf = await session.getLeafId();
	if (leaf === null) return [];
	return await session.findEntriesOnBranch({ start: leaf, order: "oldestFirst" });
}

describe("configuration_update durable writer", () => {
	it("persists an Astra thinking-level change as a durable entry", async () => {
		const session = createSession();
		const harness = await createHarness(session);

		await harness.setThinkingLevel("high");

		const entries = await branchEntries(session);
		const updates = entries.filter((entry) => entry.type === "configuration_update");
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({ type: "configuration_update", reasoning: { effort: "high" } });
	});

	it("replays the persisted effort from durable session state", async () => {
		const session = createSession();
		const harness = await createHarness(session);

		await harness.setThinkingLevel("high");
		await harness.setThinkingLevel("low");

		const context = buildSessionContext(await branchEntries(session));
		expect(context.configurationUpdate).toEqual({ effort: "low" });
	});

	it("does not append a duplicate entry for an unchanged level", async () => {
		const session = createSession();
		const harness = await createHarness(session);

		await harness.setThinkingLevel("high");
		await harness.setThinkingLevel("high");

		const entries = await branchEntries(session);
		expect(entries.filter((entry) => entry.type === "configuration_update")).toHaveLength(1);
	});
});
