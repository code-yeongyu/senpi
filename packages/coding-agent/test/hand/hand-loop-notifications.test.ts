// senpi#5898: a hosted loop's notifications run the user's handlers on the hand with the fields their local event
// carries; the hand advertises which events its user hooks listen to (so a loop never forwards a per-token event nobody
// wants); a builtin's handler never runs there; and a payload is parsed at the hand's boundary or refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createLoopHookCall } from "../../src/modes/rpc/loop-hook-call.ts";
import { extensionLoopHooks } from "../../src/modes/rpc/loopless-loop-hooks.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fieldsOf, loopEventMachine, MODEL, NOTIFICATIONS, toJson, noLateEffects } from "./loop-event-fixture.ts";
import { cleanupHands } from "./remote-hand-fixture.ts";

let user: Awaited<ReturnType<typeof loopEventMachine>>;
beforeAll(async () => {
	user = await loopEventMachine();
});
afterAll(cleanupHands);

async function handOf(extensions: { path: string; factory: ExtensionFactory }[]) {
	const loaded = await createTestExtensionsResult(extensions);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		process.cwd(),
		undefined,
		await createInMemoryModelRegistry(AuthStorage.inMemory()),
		loaded.eventBus,
	);
	return extensionLoopHooks(runner, "hand", process.cwd(), createLoopHookCall(noLateEffects));
}

describe("a hosted loop's notifications run the user's handlers on the hand (senpi#5898)", () => {
	it.each(NOTIFICATIONS)("$event reaches the user's handler with the fields its local event carries", async (row) => {
		const reply = await user.send(row.event, row.fields);

		expect(reply.errors).toBeUndefined();
		expect(reply.notices?.map((notice) => JSON.parse(notice.message))).toEqual([
			toJson({ type: row.event, ...row.fields }),
		]);
	});

	it("never runs a builtin's handler there: its loop runs it", async () => {
		const ran: string[] = [];
		const hooks = await handOf([
			{
				path: "<builtin:probe>",
				factory: (pi) => {
					pi.on("message_update", () => void ran.push("message_update"));
					pi.on("session_before_switch", () => ({ cancel: true }));
				},
			},
		]);
		const base = { sessionId: "s", idle: false };

		const update = await hooks(
			"message_update",
			toJson({ ...base, seq: 1, message: fauxAssistantMessage(""), assistantMessageEvent: { type: "start" } }),
		);
		const switched = await hooks("session_before_switch", { ...base, reason: "new" });

		expect([ran, update, switched]).toEqual([[], {}, {}]);
	});

	it.each([
		// `agent_settled` and `session_info_changed` carry only optional fields, so an empty one is a valid event.
		...NOTIFICATIONS.map((row) => row.event).filter(
			(event) =>
				![
					"agent_start",
					"agent_settled",
					"session_info_changed",
					"session_parked",
					"session_resumed",
					"session_abort",
				].includes(event),
		),
		"message_update",
		"context",
		"context_with_system",
		"session_before_switch",
		"session_before_fork",
		"session_before_tree",
		"turn_end",
		"agent_before_settle",
		"message_end",
		"model_select",
		"provider_login_start",
		"session_move_export",
		"session_move_import",
	])("refuses a %s payload without its event's fields", async (event) => {
		await expect(user.send(event, {})).rejects.toThrow(`malformed ${event} payload`);
	});

	it("refuses a model that carries headers: they can carry a credential and never leave the loop (CK21)", async () => {
		const model = { ...MODEL, headers: { authorization: "Bearer <redacted>" } };

		await expect(user.send("system_prompt_change", { ...fieldsOf("system_prompt_change"), model })).rejects.toThrow(
			"malformed system_prompt_change payload",
		);
	});

	it("refuses before_provider_headers: request headers never leave the loop (CK21)", async () => {
		await expect(user.send("before_provider_headers", { headers: {} })).rejects.toThrow(
			"no loop hooks run on a hand for before_provider_headers",
		);
	});

	it("refuses a response header that could carry a credential: only FORWARDED_RESPONSE_HEADERS cross (review L1)", async () => {
		for (const name of ["set-cookie", "www-authenticate", "x-amz-security-token"])
			await expect(
				user.send("after_provider_response", { status: 200, headers: { "x-request-id": "r", [name]: "v" } }),
			).rejects.toThrow("malformed after_provider_response payload");
	});
});

describe("a hosted loop's message stream reaches the user's message_update handler as deltas (senpi#5898 review L3)", () => {
	const empty = fauxAssistantMessage("");
	const { content: _content, ...envelope } = empty;
	const textOf = (text: string) => ({ ...envelope, content: [{ type: "text", text }] });
	/** The loop's side: it numbers every update it emits (`seq`), whether it forwards it or not (review L7). */
	const updates = (machine: Awaited<ReturnType<typeof loopEventMachine>>) => ({
		start: (seq: number) =>
			machine.send("message_update", { seq, message: empty, assistantMessageEvent: { type: "start" } }),
		textStart: (seq: number, contentIndex = 0) =>
			machine.send("message_update", {
				seq,
				envelope,
				block: { type: "text", text: "" },
				assistantMessageEvent: { type: "text_start", contentIndex },
			}),
		delta: (seq: number, delta: string, whole?: string) =>
			machine.send("message_update", {
				seq,
				...(whole === undefined ? { envelope } : { message: textOf(whole) }),
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
			}),
	});
	const seenEvent = (reply: { notices?: readonly { message: string }[] }) =>
		JSON.parse(reply.notices?.[0]?.message ?? "null") as {
			message: { content: unknown[] };
			assistantMessageEvent: { partial: unknown };
		};

	it("rebuilds each update the session's emit would give from the message the hand holds", async () => {
		const stream = updates(await loopEventMachine());

		await stream.start(1);
		await stream.textStart(2);
		await stream.delta(3, "he");
		const last = seenEvent(await stream.delta(4, "llo"));

		expect(last.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(last.assistantMessageEvent).toEqual({
			type: "text_delta",
			contentIndex: 0,
			delta: "llo",
			partial: textOf("hello"),
		});
	});

	it("asks for the whole message after a gap, then follows the stream from it (review L7)", async () => {
		const stream = updates(await loopEventMachine());
		await stream.start(1);
		await stream.textStart(2);
		await stream.delta(3, "he");

		// `wants` dropped the stream for updates 4 and 5 ("l", "l"), then took it back: update 6 cannot apply.
		const gap = await stream.delta(6, "o");
		const resent = seenEvent(await stream.delta(6, "o", "hello"));
		const next = seenEvent(await stream.delta(7, "!"));

		expect(gap).toEqual({ resync_required: true });
		expect(resent.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(next.message.content).toEqual([{ type: "text", text: "hello!" }]);
	});

	it("asks for the whole message when no stream is held for the session", async () => {
		expect(await updates(await loopEventMachine()).delta(5, "x")).toEqual({ resync_required: true });
	});

	it("refuses an update without its sequence number, or a following delta that does not fit the held block", async () => {
		const user = await loopEventMachine();
		await updates(user).start(1);

		await expect(
			user.send("message_update", {
				envelope,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
			}),
		).rejects.toThrow("malformed message_update payload");
		// The held block at 0 is text, so a thinking delta there does not fit it.
		await expect(
			user.send("message_update", {
				seq: 2,
				envelope,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x" },
			}),
		).rejects.toThrow("malformed message_update payload");
	});

	it("refuses a content index that is not a whole slot: contentIndex 0.5 (review L6)", async () => {
		const stream = updates(await loopEventMachine());
		await stream.start(1);

		await expect(stream.textStart(2, 0.5)).rejects.toThrow("malformed message_update payload");
	});
});
