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
import { loopEventMachine, MODEL, NOTIFICATIONS, toJson } from "./loop-event-fixture.ts";
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
	return extensionLoopHooks(runner, "hand", process.cwd(), createLoopHookCall());
}

describe("a hosted loop's notifications run the user's handlers on the hand (senpi#5898)", () => {
	it.each(NOTIFICATIONS)("$event reaches the user's handler with the fields its local event carries", async (row) => {
		const reply = await user.send(row.event, row.fields);

		expect(reply.errors).toBeUndefined();
		expect(reply.notices?.map((notice) => JSON.parse(notice.message))).toEqual([
			toJson({ type: row.event, ...row.fields }),
		]);
	});

	it("advertises every event the user's extension listens to, per-token ones included", async () => {
		const { wants } = await user.describe();

		expect(wants).toEqual(expect.arrayContaining(NOTIFICATIONS.map((row) => row.event)));
	});

	it("advertises only the events a user hook listens to: never a builtin's, a loop-only or a runtime one", async () => {
		const hooks = await handOf([
			{ path: "<builtin:probe>", factory: (pi) => void pi.on("message_update", () => undefined) },
			{
				path: "/user/probe.ts",
				factory: (pi) => {
					pi.on("provider_stream_event", () => undefined);
					pi.on("before_provider_headers", () => undefined);
					pi.on("tool_call", () => undefined);
				},
			},
		]);

		expect(await hooks("describe_hooks", {})).toEqual({ wants: ["provider_stream_event"] });
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

		const update = await hooks("message_update", toJson({ ...base, ...NOTIFICATIONS[4]?.fields }));
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

		await expect(user.send("system_prompt_change", { ...NOTIFICATIONS[5]?.fields, model })).rejects.toThrow(
			"malformed system_prompt_change payload",
		);
	});

	it("refuses before_provider_headers: request headers never leave the loop (CK21)", async () => {
		await expect(user.send("before_provider_headers", { headers: {} })).rejects.toThrow(
			"no loop hooks run on a hand for before_provider_headers",
		);
	});
});
