import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { deliverAnswer } from "../../../src/core/extensions/builtin/ask-user/tool.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";
import { heldHarness, wake } from "./3853-review-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

// senpi#3853 review B/M6/M9: real human input establishes attendance without changing answer hooks.
it.each(["steer", "followUp", "answer"] as const)(
	"keeps %s during input release attended and releases the goal",
	async (kind) => {
		let api: ExtensionAPI | undefined;
		const inputSources: string[] = [];
		const released: string[] = [];
		const { h, entered, release } = await heldHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.on("input", (event) => {
						inputSources.push(event.source);
					});
					pi.on("session_start", (_event, ctx) => ctx.noteHeldWake?.("goal"));
					pi.on("held_wakes_released", (event) => {
						released.push(...Object.keys(event.sources));
						if (event.sources.goal)
							pi.sendMessage(
								{ customType: "goal-continuation", content: "fresh continuation", display: false },
								{ triggerTurn: true },
							);
					});
				},
			],
		});
		harnesses.push(h);
		let goalStarted = false;
		const goalSettled = Promise.withResolvers<void>();
		h.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "goal-continuation"
			)
				goalStarted = true;
			if (goalStarted && event.type === "agent_idle") goalSettled.resolve();
		});
		await h.session.sendCustomMessage(wake, { triggerTurn: true });
		const running = h.session.prompt("continue");
		await entered.promise;
		try {
			if (kind === "answer") {
				if (!api) throw new Error("missing API");
				deliverAnswer(
					api,
					h.session.extensionRunner.createContext(),
					{
						requestId: "answer",
						questions: [{ id: "q", header: "Choice", question: "Choose", options: [], multiSelect: false }],
						waitForAnswer: false,
						timeoutMs: 1000,
					},
					{ status: "answered", answers: { q: { selected: [], text: "yes" } }, unanswered: [] },
					"codex",
				);
			} else await h.session[kind]("human input");
		} finally {
			release.resolve();
			await running;
			await h.session.waitForIdle();
		}
		expect(h.session.paused).toBe(false);
		expect(h.session.pausedNoticeCount).toBe(0);
		expect(released).toContain("goal");
		await goalSettled.promise;
		expect(
			h.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "goal-continuation",
			),
		).toHaveLength(1);
		expect(inputSources).toEqual(["interactive", kind === "answer" ? "extension" : "interactive"]);
	},
);

// Review C: a typed slash command releases before its handler uses the ordinary user-message API.
it("preserves slash command template expansion and user role while held", async () => {
	const extensionsResult = await createTestExtensionsResult([
		(pi) => {
			pi.registerCommand("review", {
				description: "Review",
				handler: async () => {
					pi.sendUserMessage("/review-template code", { expandPromptTemplates: true });
				},
			});
		},
	]);
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
		resourceLoader: {
			...createTestResourceLoader({ extensionsResult }),
			getPrompts: () => ({
				prompts: [
					{
						name: "review-template",
						description: "Review",
						content: "Review $1",
						sourceInfo: createSyntheticSourceInfo("/synthetic/review-template.md", { source: "local" }),
						filePath: "/synthetic/review-template.md",
					},
				],
				diagnostics: [],
			}),
		},
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	h.setResponses([fauxAssistantMessage([fauxText("done")])]);
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	const delivered = Promise.withResolvers<void>();
	h.session.subscribe((event) => {
		if (event.type === "agent_idle" && h.faux.state.callCount > 0) delivered.resolve();
	});
	await h.session.prompt("/review");
	await delivered.promise;
	expect(h.faux.state.callCount).toBe(1);
	expect(getUserTexts(h)).toEqual(["Review code"]);
	expect(h.session.paused).toBe(false);
});
