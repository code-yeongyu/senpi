/**
 * A terminal session's own controls, driven by another session through its control endpoint: a real
 * interactive mode (virtual terminal) over a faux-provider session, an extension registering the
 * endpoint at session start as OmO's thread component does, and requests over the live socket.
 */
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { controlData, controlRequest } from "../helpers/session-control-client.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => unknown> = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Terminal {
	readonly harness: Harness;
	readonly mode: InteractiveMode;
	readonly socket: string;
}

async function controlledTerminal(tools: AgentTool[] = []): Promise<Terminal> {
	let socket: string | undefined;
	let inboxDir = "";
	const harness = await createHarness({
		persistSession: true,
		tools,
		models: [
			{ id: "faux-reasoner", name: "Faux Reasoner", reasoning: true },
			{ id: "faux-plain", name: "Faux Plain" },
		],
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					const registration = await pi.session.registerControlEndpoint({ inboxDir, drain: () => undefined });
					if (registration.status !== "registered") throw new Error(JSON.stringify(registration));
					cleanups.push(() => registration.dispose());
					socket = registration.socket;
				});
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	inboxDir = join(harness.tempDir, "inbox");
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	cleanups.push(() => ui.stop());
	const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
	if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
	await bind.call(mode);
	if (socket === undefined) throw new Error("the terminal registered no control endpoint");
	return { harness, mode, socket };
}

function footerText(mode: InteractiveMode): string {
	const footer: unknown = Reflect.get(mode, "footer");
	if (typeof footer !== "object" || footer === null || !("render" in footer) || typeof footer.render !== "function") {
		throw new TypeError("InteractiveMode lost its footer");
	}
	const lines: unknown = footer.render(200);
	return Array.isArray(lines) ? lines.join("\n") : "";
}

/** The status line the pane shows after a command, as `/model` and the level selector set it. */
function paneStatus(mode: InteractiveMode): string {
	const status: unknown = Reflect.get(mode, "lastStatusMessage");
	return typeof status === "string" ? status : "";
}

function editorText(mode: InteractiveMode): string {
	const editor: unknown = Reflect.get(mode, "editor");
	if (
		typeof editor !== "object" ||
		editor === null ||
		!("getText" in editor) ||
		typeof editor.getText !== "function"
	) {
		throw new TypeError("InteractiveMode lost its editor");
	}
	const text: unknown = editor.getText();
	return typeof text === "string" ? text : "";
}

async function refusal(socket: string, command: Readonly<Record<string, unknown>>): Promise<unknown> {
	const reply = await controlRequest(socket, command);
	if (reply.kind !== "answered") throw new Error(`no answer to ${String(command.type)}`);
	expect(reply.record).toMatchObject({ success: false });
	return reply.record.error;
}

interface HeldTurn {
	readonly tool: AgentTool;
	readonly toolStarted: Promise<void>;
	release(): void;
}

function heldTurn(): HeldTurn {
	const toolStarted = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "hold",
		label: "Hold",
		description: "Runs until released",
		parameters: Type.Object({}),
		execute: async () => {
			toolStarted.resolve();
			await released.promise;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	return { tool, toolStarted: toolStarted.promise, release: () => released.resolve() };
}

describe.skipIf(process.platform === "win32")("a terminal session's controls over its control endpoint", () => {
	it("advertises the controls it accepts and lists the models and levels its pane offers", async () => {
		const { harness, socket } = await controlledTerminal();
		const info = await controlData(socket, { type: "get_protocol_info" });
		expect(info).toMatchObject({ mode: "tui" });
		expect((info as { commands: string[] }).commands).toEqual(
			expect.arrayContaining(["set_model", "set_thinking_level", "interrupt", "set_session_name"]),
		);
		const listing = (await controlData(socket, { type: "get_available_models" })) as { models: { id: string }[] };
		expect(listing.models.map((model) => model.id)).toEqual(expect.arrayContaining(["faux-reasoner", "faux-plain"]));
		expect(await controlData(socket, { type: "get_available_thinking_levels" })).toEqual({
			levels: harness.session.getAvailableThinkingLevels(),
		});
	});

	it("switches the model as /model does: the session and the footer follow, the default for new sessions does not", async () => {
		const { harness, mode, socket } = await controlledTerminal();
		const target = harness.getModel("faux-plain");
		if (target === undefined) throw new Error("no faux-plain model");
		const defaultBefore = harness.settingsManager.getDefaultModel();
		const reply = await controlData(socket, { type: "set_model", provider: target.provider, modelId: target.id });
		expect(reply).toMatchObject({ provider: target.provider, id: "faux-plain" });
		expect(harness.session.model?.id).toBe("faux-plain");
		expect(footerText(mode)).toContain("faux-plain");
		expect(paneStatus(mode)).toContain("faux-plain");
		// senpi#2870: a pane's selection never rewrites the default other sessions start on, and it is attributed.
		expect(harness.settingsManager.getDefaultModel()).toBe(defaultBefore);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.at(-1),
		).toMatchObject({ source: "control" });
	});

	it("refuses an unknown model with the reason and leaves the running model alone", async () => {
		const { harness, socket } = await controlledTerminal();
		const before = harness.session.model?.id;
		const error = await refusal(socket, {
			type: "set_model",
			provider: harness.getModel().provider,
			modelId: "no-such",
		});
		expect(error).toBe(`Model not found: ${harness.getModel().provider}/no-such`);
		expect(harness.session.model?.id).toBe(before);
	});

	it("applies a supported thinking level and refuses one the active model cannot run, changing nothing", async () => {
		const { harness, mode, socket } = await controlledTerminal();
		const levels = harness.session.getAvailableThinkingLevels();
		const supported = levels.find((level) => level !== harness.session.thinkingLevel && level !== "off");
		if (supported === undefined) throw new Error(`the reasoning model offers no other level: ${levels}`);
		expect(
			await controlData(socket, { type: "set_thinking_level", level: supported, scope: "turn" }),
		).toBeUndefined();
		expect(harness.session.thinkingLevel).toBe(supported);
		expect(footerText(mode)).toContain(supported);
		expect(paneStatus(mode)).toContain(supported);

		const plain = harness.getModel("faux-plain");
		if (plain === undefined) throw new Error("no faux-plain model");
		await controlData(socket, { type: "set_model", provider: plain.provider, modelId: plain.id });
		const current = harness.session.thinkingLevel;
		expect(await refusal(socket, { type: "set_thinking_level", level: "high" })).toBe(
			"Thinking level high is not supported by the active model.",
		);
		expect(harness.session.thinkingLevel).toBe(current);
	});

	it("remembers a level for the model only without scope turn, as the selector's Ctrl+S does", async () => {
		const { harness, socket } = await controlledTerminal();
		const model = harness.session.model;
		if (model === undefined) throw new Error("no active model");
		const levels = harness.session.getAvailableThinkingLevels().filter((level) => level !== "off");
		const [first, second] = levels.filter((level) => level !== harness.session.thinkingLevel);
		if (first === undefined || second === undefined)
			throw new Error(`the reasoning model offers too few levels: ${levels}`);
		const remembered = harness.settingsManager.getModelThinkingLevel(model.provider, model.id);

		await controlData(socket, { type: "set_thinking_level", level: first, scope: "turn" });
		expect(harness.session.thinkingLevel).toBe(first);
		expect(harness.settingsManager.getModelThinkingLevel(model.provider, model.id)).toBe(remembered);

		await controlData(socket, { type: "set_thinking_level", level: second });
		expect(harness.session.thinkingLevel).toBe(second);
		expect(harness.settingsManager.getModelThinkingLevel(model.provider, model.id)).toBe(second);
	});

	it("answers interrupted: false on an idle session and keeps it open", async () => {
		const { harness, socket } = await controlledTerminal();
		expect(await controlData(socket, { type: "interrupt" })).toEqual({ interrupted: false });
		expect(harness.session.isStreaming).toBe(false);
		expect(await controlData(socket, { type: "get_state" })).toMatchObject({ isStreaming: false });
	});

	it("stops a running turn as Esc does: a stale turn id is left alone, queued input returns to the editor, the session stays open", async () => {
		const held = heldTurn();
		const { harness, mode, socket } = await controlledTerminal([held.tool]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("never reached"),
		]);
		const run = harness.session.prompt("keep going");
		await held.toolStarted;
		const { turn_epoch } = (await controlData(socket, { type: "get_state" })) as { turn_epoch: number };
		const turnId = String(turn_epoch);

		expect(await controlData(socket, { type: "interrupt", turnId: "stale" })).toEqual({ interrupted: false, turnId });
		expect(harness.session.isStreaming).toBe(true);

		await harness.session.followUp("queued while it ran");
		expect(await controlData(socket, { type: "interrupt", turnId })).toEqual({ interrupted: true, turnId });
		expect(harness.session.isStreaming).toBe(false);
		expect(editorText(mode)).toBe("queued while it ran");
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		held.release();
		await run;
		expect(await controlData(socket, { type: "get_state" })).toMatchObject({ isStreaming: false, turn_epoch });
		expect(await controlData(socket, { type: "set_session_name", name: "still-open" })).toBeUndefined();
		expect(harness.session.sessionName).toBe("still-open");
	});
});
