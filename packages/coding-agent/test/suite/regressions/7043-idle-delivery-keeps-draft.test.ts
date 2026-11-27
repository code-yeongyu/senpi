/**
 * senpi#7043: a peer delivery to an idle terminal starts its own turn even while the person has a draft in the
 * composer. The draft is not submitted, merged or cleared, and the sender is answered `started`. With a turn
 * running, the delivery stays a follow-up of that turn and the draft stays out of it. A real interactive mode
 * (virtual terminal, real composer) registers the endpoint and drains peer deliveries the way OmO's gateway does:
 * read the admission gate, then admit.
 */
import { writeFileSync } from "node:fs";
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
	readonly inboxDir: string;
	/** Every admission any drain pass answered, the endpoint's own wakes included, in order. */
	readonly admissions: SessionControlAdmission[];
	send(id: string, text: string): void;
	/** Resolves once a drain pass has admitted `id`. */
	admitted(id: string): Promise<void>;
}

/**
 * Hands a delivery to the terminal and asks it to drain, the way a sender does, then answers every admission of that
 * delivery. The endpoint also drains on its own (the inbox watch, its arming, idle and emitted wakes), and one of those
 * passes can take the delivery before the sender's wake runs; the sender's wake then answers nothing (senpi#7483). The
 * contract is that the delivery is admitted exactly once, so the answer collects every pass, not only the sender's,
 * after waiting for the admission itself: the helper must not depend on which pass ran or on that pass recording its
 * admission before the sender's wake answers.
 */
async function admit(tui: Terminal, id: string, text: string): Promise<SessionControlAdmission[]> {
	tui.send(id, text);
	await controlData(tui.socket, { type: "wake" });
	await tui.admitted(id);
	return tui.admissions.filter((admission) => admission.delivery_id === id);
}

async function terminal(responses: FauxResponseStep[], tools: AgentTool[] = []): Promise<Terminal> {
	const inbox = new Map<string, string>();
	const admissions: SessionControlAdmission[] = [];
	const waiters = new Map<string, Array<() => void>>();
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
								admissions.push({ delivery_id, kind });
								for (const resolve of waiters.get(delivery_id)?.splice(0) ?? []) resolve();
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
	return {
		harness,
		socket,
		composer,
		requests,
		inboxDir,
		admissions,
		send: (id, text) => inbox.set(id, text),
		admitted: (id) =>
			admissions.some((admission) => admission.delivery_id === id)
				? Promise.resolve()
				: new Promise((resolve) => waiters.set(id, [...(waiters.get(id) ?? []), resolve])),
	};
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

		expect(await admit(tui, "d1", "peer message one")).toEqual([{ delivery_id: "d1", kind: "started" }]);
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

		expect(await admit(tui, "d1", "peer message one")).toEqual([{ delivery_id: "d1", kind: "started" }]);
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

		expect(await admit(tui, "d1", "peer message one")).toEqual([{ delivery_id: "d1", kind: "queued" }]);
		held.release();
		await run;
		await written;
		await tui.harness.session.waitForIdle();

		expect(transcript(tui.harness)).toEqual(["user:start", "delivery:d1"]);
		expect(tui.requests.at(-1)).toContain("peer message one");
		for (const request of tui.requests) expect(request).not.toContain(DRAFT);
		expect(tui.composer.getText()).toBe(DRAFT);
	});

	// senpi#7483: the endpoint's own inbox wake takes the delivery before the sender's wake runs. The delivery is still
	// admitted exactly once, as the running turn's follow-up; the sender's wake finds nothing left and answers nothing.
	it("the endpoint's own wake drains the delivery first: it is still admitted once, as the turn's follow-up", async () => {
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
		const written = emitted(tui.harness, "d1");

		tui.send("d1", "peer message one");
		writeFileSync(join(tui.inboxDir, "nudge"), "");
		await tui.admitted("d1");
		expect(await controlData(tui.socket, { type: "wake" })).toEqual({ admitted: [] });
		expect(tui.admissions.filter((admission) => admission.delivery_id === "d1")).toEqual([
			{ delivery_id: "d1", kind: "queued" },
		]);
		held.release();
		await run;
		await written;
		await tui.harness.session.waitForIdle();

		expect(transcript(tui.harness)).toEqual(["user:start", "delivery:d1"]);
	});
});
