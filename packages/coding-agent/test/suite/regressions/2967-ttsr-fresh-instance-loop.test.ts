import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import ttsrExtension from "../../../src/core/extensions/builtin/ttsr/index.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Entry = Record<string, unknown>;

const AUTO_TURNS = 8;
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function reply(turn: number): string {
	return `qa-local-model replies to ${(0xabc123 + turn * 7919).toString(16)}f00d: the deterministic mock answer for this request.`;
}

function assistantEntry(text: string): Entry {
	return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

function freshInstance(entries: Entry[], sent: unknown[]) {
	const handlers = new Map<string, Handler[]>();
	const api = new Proxy(
		{
			on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			getFlag: () => undefined,
			events: { emit: () => undefined, on: () => () => undefined },
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
			sendMessage: (message: { customType?: string; details?: unknown }, options?: { triggerTurn?: boolean }) => {
				if (options?.triggerTurn === true) sent.push(message);
				entries.push({ type: "custom_message", customType: message.customType, details: message.details });
			},
		},
		{ get: (target, key) => Reflect.get(target, key) ?? (() => undefined) },
	) as unknown as ExtensionAPI;
	ttsrExtension(api);
	return handlers;
}

async function emit(handlers: Map<string, Handler[]>, event: string, payload: unknown, ctx: ExtensionContext) {
	let result: unknown;
	for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
	return result;
}

function context(cwd: string, entries: Entry[]): ExtensionContext {
	return {
		cwd,
		mode: "print",
		hasUI: false,
		abort: () => undefined,
		ui: { notify: () => undefined },
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;
}

describe("senpi#2967 a host that rebuilds the ttsr extension every turn", () => {
	it("injects at most one repetitive-turns follow-up for one user message", async () => {
		// given a session whose last user message got a reply that the model keeps repeating, and a
		// host that starts a fresh ttsr instance for every automatic turn (the desktop host does)
		const cwd = mkdtempSync(join(tmpdir(), "senpi-2967-"));
		directories.push(cwd);
		const entries: Entry[] = [
			{ type: "message", message: { role: "user", content: "first message" } },
			assistantEntry(reply(0)),
			{ type: "message", message: { role: "user", content: "After edit check" } },
		];
		const sent: unknown[] = [];

		// when every automatic turn runs on a fresh instance with no user input in between
		for (let turn = 1; turn <= AUTO_TURNS; turn++) {
			const handlers = freshInstance(entries, sent);
			const ctx = context(cwd, entries);
			await emit(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);
			await emit(handlers, "turn_start", { type: "turn_start" }, ctx);
			const text = reply(turn);
			await emit(
				handlers,
				"message_update",
				{ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } },
				ctx,
			);
			const message = { role: "assistant", content: [{ type: "text", text }] };
			await emit(handlers, "message_end", { type: "message_end", message }, ctx);
			entries.push(assistantEntry(text));
			await emit(handlers, "agent_end", { type: "agent_end", messages: [], abortSource: "system" }, ctx);
			await emit(handlers, "agent_settled", { type: "agent_settled" }, ctx);
		}

		// then the rule triggered at most one follow-up turn for that single user message
		expect(sent.length).toBeLessThanOrEqual(1);
	});
});
