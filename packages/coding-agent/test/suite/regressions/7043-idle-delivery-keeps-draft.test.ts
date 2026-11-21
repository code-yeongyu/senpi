/**
 * senpi#7043: a peer delivery to an idle terminal starts its own turn even while the person has a draft in the
 * composer. The draft is not submitted, merged or cleared, and the sender is answered `started`. With a turn
 * running, the delivery stays a follow-up of that turn and the draft stays out of it. A real interactive mode
 * (virtual terminal, real composer) registers the endpoint and drains peer deliveries the way OmO's gateway does:
 * read the admission gate, then admit.
 */
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { SessionControlAdmission } from "../../../src/core/extensions/types.ts";
import { deliveryIdOf } from "../../../src/core/external-admission.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { controlData } from "../../helpers/session-control-client.ts";
import { createHarness, type Harness } from "../harness.ts";

const DRAFT = "half-typed draft, not sent yet";
const cleanups: Array<() => unknown> = [];
beforeAll(() => initTheme("dark"));
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Composer {
	getText(): string;
	setText(text: string): void;
}

interface Terminal {
	readonly harness: Harness;
	readonly socket: string;
	readonly composer: Composer;
	readonly requests: string[];
	send(id: string, text: string): void;
}

async function terminal(responses: FauxResponseStep[], tools: AgentTool[] = []): Promise<Terminal> {
	const inbox = new Map<string, string>();
	let socket: string | undefined;
	let inboxDir = "";
	const harness = await createHarness({
		persistSession: true,
		tools,
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					const registration = await pi.session.registerControlEndpoint({
						inboxDir,
						drain: () => {
							const admitted: SessionControlAdmission[] = [];
							for (const [delivery_id, text] of inbox) {
								const kind = pi.session.admissionGate().can_admit
									? pi.session.admitExternalMessage({
											delivery_id,
											text,
											deliverAs: "followUp",
											sender: { kind: "agent", session_id: "peer-session", name: "peer" },
										}).kind
									: "held_draft";
								admitted.push({ delivery_id, kind });
								if (kind !== "held_draft") inbox.delete(delivery_id);
							}
							return { admitted };
						},
					});
					if (registration.status !== "registered") throw new Error(JSON.stringify(registration));
					cleanups.push(() => registration.dispose());
					socket = registration.socket;
				});
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	inboxDir = join(harness.tempDir, "inbox");
	const requests: string[] = [];
	harness.setResponses(
		responses.map((step) => async (context, options, state, model) => {
			requests.push(JSON.stringify(context));
			return typeof step === "function" ? step(context, options, state, model) : step;
		}),
	);
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	cleanups.push(() => ui.stop());
	const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
	if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
	await bind.call(mode);
	if (socket === undefined) throw new Error("the terminal registered no control endpoint");
	const composer: Composer = Reflect.get(mode, "editor");
	return { harness, socket, composer, requests, send: (id, text) => inbox.set(id, text) };
}

function emitted(harness: Harness, id: string): Promise<void> {
	return new Promise((resolve) => {
		const stop = harness.session.externalAdmission.onEmitted((written) => {
			if (written !== id) return;
			stop();
			resolve();
		});
	});
}

function transcript(harness: Harness): string[] {
	return harness.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type === "message" && entry.message.role === "user") {
			const content = entry.message.content;
			const text =
				typeof content === "string" ? content : content.map((part) => ("text" in part ? part.text : "")).join("");
			return [`user:${text}`];
		}
		if (entry.type !== "custom_message") return [];
		const id = deliveryIdOf({ role: "custom", ...entry, timestamp: 0 });
		return id === undefined ? [] : [`delivery:${id}`];
	});
}

function heldTool(): { tool: AgentTool; started: Promise<void>; release(): void } {
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	return {
		tool: {
			name: "hold",
			label: "Hold",
			description: "Holds the turn",
			parameters: Type.Object({}),
			execute: async () => {
				started.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		},
		started: started.promise,
		release: () => gate.resolve(),
	};
}

describe("a peer delivery to an idle terminal starts its own turn and leaves the draft alone (senpi#7043)", () => {
	it("idle with a draft in the composer: the delivery starts a turn carrying only itself, the draft stays", async () => {
		const tui = await terminal([fauxAssistantMessage("answered the peer")]);
		tui.composer.setText(DRAFT);
		const written = emitted(tui.harness, "d1");

		tui.send("d1", "peer message one");
		expect(await controlData(tui.socket, { type: "wake" })).toEqual({
			admitted: [{ delivery_id: "d1", kind: "started" }],
		});
		await written;
		await tui.harness.session.waitForIdle();

		expect(transcript(tui.harness)).toEqual(["delivery:d1"]);
		expect(tui.requests).toHaveLength(1);
		expect(tui.requests[0]).toContain("peer message one");
		expect(tui.requests[0]).not.toContain(DRAFT);
		expect(tui.composer.getText()).toBe(DRAFT);
	});

	it("idle with an empty composer: the delivery starts a turn the same way", async () => {
		const tui = await terminal([fauxAssistantMessage("answered the peer")]);
		const written = emitted(tui.harness, "d1");

		tui.send("d1", "peer message one");
		expect(await controlData(tui.socket, { type: "wake" })).toEqual({
			admitted: [{ delivery_id: "d1", kind: "started" }],
		});
		await written;
		await tui.harness.session.waitForIdle();

		expect(transcript(tui.harness)).toEqual(["delivery:d1"]);
		expect(tui.composer.getText()).toBe("");
	});

	it("a turn running with a draft in the composer: the delivery is that turn's follow-up, without the draft", async () => {
		const held = heldTool();
		const tui = await terminal(
			[
				fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("tool done"),
				fauxAssistantMessage("answered the peer"),
			],
			[held.tool],
		);
		const run = tui.harness.session.prompt("start");
		await held.started;
		tui.composer.setText(DRAFT);
		const written = emitted(tui.harness, "d1");

		tui.send("d1", "peer message one");
		expect(await controlData(tui.socket, { type: "wake" })).toEqual({
			admitted: [{ delivery_id: "d1", kind: "queued" }],
		});
		held.release();
		await run;
		await written;
		await tui.harness.session.waitForIdle();

		expect(transcript(tui.harness)).toEqual(["user:start", "delivery:d1"]);
		expect(tui.requests.at(-1)).toContain("peer message one");
		for (const request of tui.requests) expect(request).not.toContain(DRAFT);
		expect(tui.composer.getText()).toBe(DRAFT);
	});
});
