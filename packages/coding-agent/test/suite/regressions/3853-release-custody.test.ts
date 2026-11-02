import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

// senpi#3853: an agent_end acknowledges only the notices actually sent in that turn.
it.each([
	["senpi-codemode:notification", "resume"],
	["senpi-monitor:event", "resume"],
	["senpi-codemode:notification", "input"],
	["senpi-monitor:event", "input"],
])("delivers a late %s wake according to attendance during %s release", async (customType, releaseKind) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		tools: [
			{
				name: "barrier",
				label: "Barrier",
				description: "Wait for the test event.",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await h.session.sendCustomMessage(
		{ customType: "senpi-codemode:notification", content: "original", display: false },
		{ triggerTurn: true },
	);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("barrier", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("first delivered")]),
		fauxAssistantMessage([fauxText("late delivered")]),
	]);
	const resumed = releaseKind === "input" ? h.session.prompt("continue") : h.session.resumeSession();
	try {
		await entered.promise;
		await h.session.sendCustomMessage(
			{ customType, content: "late completion", display: false },
			{ triggerTurn: true },
		);
	} finally {
		release.resolve();
		await resumed;
	}
	expect(h.faux.state.callCount).toBe(2);
	expect(h.session.paused).toBe(releaseKind === "resume");
	expect(h.session.pausedNoticeCount).toBe(releaseKind === "resume" ? 1 : 0);
	if (releaseKind === "resume") {
		await h.session.resumeSession();
		expect(h.faux.state.callCount).toBe(3);
	}
	expect(h.session.pausedNoticeCount).toBe(0);
	expect(h.session.messages.filter((m) => m.role === "custom" && m.content === "original")).toHaveLength(1);
	expect(
		h.session.messages.filter(
			(m) => m.role === "custom" && typeof m.content === "string" && m.content.includes("late completion"),
		),
	).toHaveLength(1);
});

it("retains a rejected final-admission wake without also queuing native work", async () => {
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		models: [{ id: "small", contextWindow: 1024, maxTokens: 128 }],
		settings: { compaction: { enabled: true, reserveTokens: 0 } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => ({
					message: { customType: "large-context", content: "oversized ".repeat(4000), display: false },
				}));
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	await h.session.sendCustomMessage(
		{ customType: "senpi-codemode:notification", content: "retain this completion", display: false },
		{ triggerTurn: true },
	);
	await expect(h.session.resumeSession()).rejects.toThrow();
	expect(h.faux.state.callCount).toBe(0);
	expect(h.session.paused).toBe(true);
	expect(h.session.pausedNoticeCount).toBe(1);
	expect(h.agent.hasQueuedMessages()).toBe(false);
});
