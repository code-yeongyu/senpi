import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { KILL_ATTACH_CASES } from "../../src/modes/rpc/testing/kill-attach.ts";
import { reservationStep } from "../suite/rpc-worker-reservation-support.ts";
import { OWNED_TURN_ENTRY } from "./headless-host-support.ts";
import { disposing, released, takeoverRig } from "./takeover-host-support.ts";

describe("quiet takeover on a headless engine (R21)", () => {
	it(
		"opening a session elsewhere takes it over: the previous client lets go quietly and the running turn finishes",
		() =>
			disposing(takeoverRig(), async ({ rig, open, takeOver, lifecycle, takeovers, attachments }) => {
				rig.connect("a");
				rig.connect("b");
				const session = await open("a");
				const turn = rig.send("a", {
					type: "prompt",
					id: "turn",
					sessionId: session.sessionId,
					message: "/owned-turn",
				});
				await reservationStep("takeover-turn-started", rig.turnStarted);

				const reply = await takeOver("b", session, "device-b");

				expect(reply).toMatchObject({
					success: true,
					data: { sessionId: session.sessionId, attached: true, holder: "device-b", generation: 1, released: 1 },
				});
				expect(lifecycle("a")).toEqual([released(session.sessionId)]);
				expect(lifecycle("b")).toEqual([]);
				expect(await attachments("b")).toEqual({ [session.sessionId]: 1 });
				expect(await takeovers()).toEqual(["device-b@1"]);
				rig.releaseTurn();
				await reservationStep("takeover-turn-finished", turn);
				expect(SessionManager.open(session.file).getEntries()).toContainEqual(
					expect.objectContaining({ type: "custom", customType: OWNED_TURN_ENTRY }),
				);
				expect(lifecycle("a")).toEqual([released(session.sessionId)]);
			}),
		30_000,
	);

	it(
		"releases every hold of the previous client; a takeover retried by the holder records nothing new",
		() =>
			disposing(takeoverRig(), async ({ rig, call, open, takeOver, lifecycle, takeovers, attachments }) => {
				rig.connect("a");
				rig.connect("b");
				const session = await open("a");
				await call("a", { type: "open_session", cwd: rig.root, sessionPath: session.file });
				expect(await attachments("a")).toEqual({ [session.sessionId]: 2 });
				await takeOver("b", session, "device-b");
				expect(await attachments("b")).toEqual({ [session.sessionId]: 1 });
				const again = await takeOver("b", session, "device-b");

				expect(again).toMatchObject({ success: true, data: { holder: "device-b", generation: 1, released: 0 } });
				expect(await takeovers()).toEqual(["device-b@1"]);
				expect(lifecycle("a")).toEqual([released(session.sessionId)]);
			}),
		30_000,
	);

	it(
		"MULTI: one session is taken over and taken back while the client's other session runs on",
		() =>
			disposing(takeoverRig(), async ({ rig, open, takeOver, lifecycle, takeovers, attachments }) => {
				rig.connect("a");
				rig.connect("b");
				const first = await open("a");
				const second = await open("a");
				const turn = rig.send("a", {
					type: "prompt",
					id: "turn",
					sessionId: second.sessionId,
					message: "/owned-turn",
				});
				await reservationStep("multi-turn-started", rig.turnStarted);

				await takeOver("b", first, "device-b");
				expect(await attachments("a")).toEqual({ [first.sessionId]: 1, [second.sessionId]: 1 });
				expect(lifecycle("a")).toEqual([released(first.sessionId)]);

				const back = await takeOver("a", first, "device-a");
				expect(back).toMatchObject({ success: true, data: { holder: "device-a", generation: 2, released: 1 } });
				expect(lifecycle("b")).toEqual([released(first.sessionId)]);
				expect(await attachments("a")).toEqual({ [first.sessionId]: 1, [second.sessionId]: 1 });

				rig.releaseTurn();
				await reservationStep("multi-turn-finished", turn);
				expect(SessionManager.open(second.file).getEntries()).toContainEqual(
					expect.objectContaining({ type: "custom", customType: OWNED_TURN_ENTRY }),
				);
				expect(lifecycle("a").filter((record) => record.sessionId === second.sessionId)).toEqual([]);
				expect(await takeovers()).toEqual(["device-b@1", "device-a@2"]);
			}),
		30_000,
	);

	it("refuses a takeover without a holder, and on a host that cannot take over; an ordinary attach still joins", async () => {
		for (const [kind, ledger, code] of [
			["headless", true, "takeover_holder_required"],
			["headless", false, "takeover_unsupported"],
			["client-owned", true, "takeover_unsupported"],
		] as const) {
			await disposing(takeoverRig(kind, ledger), async ({ rig, call, open, lifecycle, attachments }) => {
				rig.connect("a");
				rig.connect("b");
				const session = await open("a");
				const ids = { sessionId: session.sessionId, durableSessionId: session.durableSessionId };
				const refused = await call("b", {
					type: "attach_session",
					...ids,
					takeover: true,
					...(code === "takeover_holder_required" ? {} : { holder: "device-b" }),
				});
				expect(refused).toMatchObject({ success: false, error: code });
				expect(await call("b", { type: "attach_session", ...ids })).toMatchObject({ success: true });
				expect(await attachments("a")).toEqual({ [session.sessionId]: 2 });
				expect(lifecycle("a")).toEqual([]);
			});
		}
	}, 60_000);
});

describe("KILL-ATTACH on the durable store", () => {
	const media = new Map<string, ReturnType<typeof createMemoryStoreMedium>>();
	const adapter = {
		createAdmission: createAdmissionLine,
		createMedium: async () => {
			const name = `medium-${media.size}`;
			media.set(name, createMemoryStoreMedium());
			return name;
		},
		open: async (name: string, options?: Parameters<typeof openMemoryStore>[1]) => {
			const medium = media.get(name);
			if (medium === undefined) throw new Error(`no medium ${name}`);
			return openMemoryStore(medium, options);
		},
	};

	it.each(KILL_ATTACH_CASES.map((killCase) => [killCase.id, killCase] as const))("%s", async (_id, killCase) => {
		await killCase.run(adapter);
	});
});
