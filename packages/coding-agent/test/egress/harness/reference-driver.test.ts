import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isStepCommitError } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createReferenceDriver, projectHistoryRows, type ReferenceDriver } from "./reference-driver.ts";

const assistantTexts = (messages: readonly AgentMessage[]): string[] =>
	messages.flatMap((message) =>
		message.role === "assistant" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
	);

describe("CK22 reference hosted session driver (custody 15.1, 15.2)", () => {
	let driver: ReferenceDriver | undefined;

	afterEach(() => {
		driver?.cleanup();
		driver = undefined;
	});

	it("latches and bumps the generation before the rejected commit reaches the session", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")])]);
		driver.inject.nextCommit("reject");
		const seen: Array<{ type: string; generation: number }> = [];
		driver.session.subscribe((event) => {
			seen.push({ type: event.type, generation: driver?.generation ?? -1 });
		});

		await driver.session.prompt("go").catch((error: unknown) => {
			if (!isStepCommitError(error)) throw error;
		});

		expect(driver.latchHistory).toMatchObject([
			{ stepId: "step-1", code: "storage_unavailable", generationAfter: 2 },
		]);
		const settled = seen.filter((entry) => entry.type === "agent_settled");
		expect(settled.length).toBeGreaterThan(0);
		expect(settled.every((entry) => entry.generation === 2)).toBe(true);
	});

	it("refuses a provider call from the discarded instance and dials nothing", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("never")])]);
		driver.inject.nextCommit("reject");
		const oldSession = driver.session;
		await driver.prompt("go");
		const providerCalls = driver.counters.providerCalls;
		const refusals = driver.counters.refusals;
		const rows = driver.rows.length;

		await oldSession.prompt("retry from the old instance").catch(() => undefined);

		expect(driver.counters.refusals).toBeGreaterThan(refusals);
		expect(driver.counters.providerCalls).toBe(providerCalls);
		expect(driver.rows).toHaveLength(rows);
	});

	it("rebuilds from durable history: the rebuilt state equals the projected rows and lacks the uncommitted message", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("kept")]), fauxAssistantMessage([fauxText("lost")])]);
		await driver.prompt("first");
		driver.inject.nextCommit("reject");
		const oldSession = driver.session;

		await driver.prompt("second");

		expect(driver.rebuilds).toBe(1);
		expect(driver.session).not.toBe(oldSession);
		expect(driver.session.agent.state.messages).toEqual(projectHistoryRows(driver.rows));
		expect(assistantTexts(driver.session.agent.state.messages)).toEqual(["kept"]);
		expect(assistantTexts(oldSession.agent.state.messages)).toContain("lost");
	});

	it("keeps queued input in the always-on inbox across a latch and delivers it once after the rebuild", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")]), fauxAssistantMessage([fauxText("answered")])]);
		driver.inject.nextCommit("reject");

		await driver.followUp("later");
		expect(driver.inbox.map((entry) => ({ text: entry.text, consumedBy: entry.consumedBy }))).toEqual([
			{ text: "later", consumedBy: undefined },
		]);
		const oldSession = driver.session;

		await driver.prompt("go");
		await driver.settle();
		const refusals = driver.counters.refusals;
		await oldSession.agent.continue().catch(() => undefined);

		expect(driver.counters.refusals).toBeGreaterThan(refusals);
		const laterRows = driver.rows.filter(
			(row) => row.message.role === "user" && JSON.stringify(row.message.content).includes("later"),
		);
		expect(laterRows).toHaveLength(1);

		expect(driver.rebuilds).toBe(1);
		expect(driver.inbox.map((entry) => entry.consumedBy)).toEqual([2]);
		expect(driver.counters.drainedBy).toEqual([2]);
		const sawLater = driver
			.callLog()
			.filter((call) =>
				call.context.messages.some(
					(message) =>
						message.role === "user" &&
						(typeof message.content === "string"
							? message.content === "later"
							: message.content.some((part) => part.type === "text" && part.text === "later")),
				),
			);
		expect(sawLater).toHaveLength(1);
		expect(assistantTexts(projectHistoryRows(driver.rows))).toEqual(["answered"]);
	});

	it("never forwards an event the discarded instance emits after the latch", async () => {
		driver = await createReferenceDriver();
		driver.setResponses([fauxAssistantMessage([fauxText("lost")])]);
		driver.inject.nextCommit("reject");

		await driver.prompt("go");

		const latchedAt = driver.latchHistory[0]?.forwardedBefore ?? -1;
		const afterLatch = driver.forwarded.slice(latchedAt);
		expect(afterLatch.every((entry) => entry.generation === 2)).toBe(true);
		expect(driver.counters.events).toBe(driver.forwarded.length);
	});
});
