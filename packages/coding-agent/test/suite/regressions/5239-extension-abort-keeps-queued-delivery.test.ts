/**
 * senpi#5239: an extension abort (`ctx.abort()`) stops the running turn, but input the person already submitted
 * keeps its delivery. It used to be drained into the composer as an unsent draft, so an unattended session stalled
 * with the message sitting in the editor. A real interactive mode (virtual terminal, real composer) binds the
 * extension abort handler; the queued follow-up must be sent once the aborted run is idle, with no Enter press.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

const QUEUED = "queued while the turn was running";
const cleanups: Array<() => unknown> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function userTexts(entries: ReturnType<Awaited<ReturnType<typeof createHarness>>["sessionManager"]["getEntries"]>) {
	return entries.flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		return [
			typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join(""),
		];
	});
}

describe("an extension abort keeps queued input delivering (senpi#5239)", () => {
	it("sends the queued follow-up once the aborted run is idle and never puts it in the composer", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		const hold: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Holds the turn",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		let extensionContext: ExtensionContext | undefined;
		const harness = await createHarness({
			tools: [hold],
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("tool_execution_start", (_event, ctx) => {
						extensionContext = ctx;
					});
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		const requests: string[] = [];
		const queuedRequested = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			(context) => {
				requests.push(JSON.stringify(context));
				queuedRequested.resolve();
				return fauxAssistantMessage("answered the queued message");
			},
		]);
		const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
		const mode = new InteractiveMode(runtime);
		const ui = new TUI(new VirtualTerminal(120, 40));
		Reflect.set(mode, "ui", ui);
		cleanups.push(() => ui.stop());
		const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
		if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
		await bind.call(mode);
		const composer: { getText(): string } = Reflect.get(mode, "editor");

		const run = harness.session.prompt("start");
		await toolStarted.promise;
		await harness.session.followUp(QUEUED);
		expect(harness.session.getFollowUpMessages()).toEqual([QUEUED]);
		if (extensionContext === undefined) throw new Error("the extension saw no tool execution");

		extensionContext.abort();
		expect(composer.getText()).toBe("");
		releaseTool.resolve();
		await run;

		await queuedRequested.promise;
		await harness.session.waitForIdle();

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain(QUEUED);
		expect(userTexts(harness.sessionManager.getEntries())).toEqual(["start", QUEUED]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(composer.getText()).toBe("");
	});
});
