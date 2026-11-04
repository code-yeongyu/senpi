import { describe, expect, it } from "vitest";
import type { AttachLedger } from "../../src/modes/rpc/attach-ledger.ts";
import { disposing, type Opened, released, takeoverRig } from "./takeover-host-support.ts";

type Rig = Awaited<ReturnType<typeof takeoverRig>>;

/**
 * Each row lands one disturbance at one await of a takeover by `b` of a session `a` holds: while the ledger commit is
 * in flight, or while the takeover's `session_released` notice to `a` is being queued (the release phase). The
 * expectations are the answer `b` gets and the hold count the session is left with.
 */
interface RaceRow {
	readonly name: string;
	readonly at: "commit" | "notice";
	readonly holds: number;
	readonly disturb: (rig: Rig, session: Opened) => Promise<unknown>;
	readonly answer: string | undefined;
	/** `null`: not checked (a drain parks the session on its own schedule). */
	readonly attachments: number | undefined | null;
	readonly aReleased: boolean;
}

const ROWS: readonly RaceRow[] = [
	{
		name: "the taker disconnects",
		at: "commit",
		holds: 2,
		disturb: (t) => t.rig.detach("b"),
		answer: undefined,
		attachments: 2,
		aReleased: false,
	},
	{
		name: "the session closes",
		at: "commit",
		holds: 1,
		disturb: (t, s) => t.call("a", { type: "close_session", sessionId: s.sessionId }),
		answer: "unknown_session",
		attachments: undefined,
		aReleased: false,
	},
	{
		name: "the host starts draining",
		at: "commit",
		holds: 2,
		disturb: async (t) => t.rig.core.router.beginDrain(),
		answer: "session_busy_lifecycle",
		attachments: null,
		aReleased: false,
	},
	{
		name: "the ledger write fails",
		at: "commit",
		holds: 2,
		disturb: async () => {},
		answer: "takeover_failed",
		attachments: 2,
		aReleased: false,
	},
	{
		name: "the previous client disconnects",
		at: "notice",
		holds: 2,
		disturb: (t) => t.rig.detach("a"),
		answer: "ok",
		attachments: 1,
		aReleased: false,
	},
	{
		name: "the previous client releases a hold",
		at: "notice",
		holds: 2,
		disturb: (t, s) => t.call("a", { type: "release_attachment", sessionId: s.sessionId }),
		answer: "ok",
		attachments: 1,
		aReleased: true,
	},
	{
		name: "a second client takes over",
		at: "notice",
		holds: 2,
		disturb: (t, s) => t.takeOver("c", s, "device-c"),
		answer: "ok",
		attachments: 1,
		aReleased: true,
	},
];

function ledgerFor(row: RaceRow, commit: { disturb?: () => Promise<unknown> }) {
	return (inner: AttachLedger): AttachLedger => ({
		holderOf: (sessionId) => inner.holderOf(sessionId),
		takeOver: async (sessionId, holder) => {
			if (row.at !== "commit" || holder !== "device-b") return inner.takeOver(sessionId, holder);
			await commit.disturb?.();
			if (row.name === "the ledger write fails") throw new Error("store fenced");
			return inner.takeOver(sessionId, holder);
		},
	});
}

describe("a takeover reads the host's shared state only after its last await (S37 races)", () => {
	it.each(ROWS.map((row) => [`${row.at}: ${row.name}`, row] as const))(
		"%s",
		async (_name, row) => {
			const commit: { disturb?: () => Promise<unknown> } = {};
			await disposing(takeoverRig("headless", true, ledgerFor(row, commit)), async (t) => {
				for (const connection of ["a", "b", "c"]) t.rig.connect(connection);
				const session = await t.open("a");
				for (let hold = 1; hold < row.holds; hold++)
					await t.call("a", { type: "open_session", cwd: t.rig.root, sessionPath: session.file });
				let disturbed: Promise<unknown> = Promise.resolve();
				commit.disturb = () => (disturbed = row.disturb(t, session));
				if (row.at === "notice") {
					const enqueueControl = t.rig.writer.enqueueControl.bind(t.rig.writer);
					let armed = true;
					t.rig.writer.enqueueControl = (value, target) => {
						if (armed && target === "a" && Reflect.get(value, "type") === "session_released") {
							armed = false;
							disturbed = row.disturb(t, session);
						}
						return enqueueControl(value, target);
					};
				}

				await t.rig.send("b", {
					type: "attach_session",
					id: "take",
					...ids(session),
					takeover: true,
					holder: "device-b",
				});
				await disturbed;
				const answer = t.rig.recordsFor("b").find((record) => record.id === "take");

				expect(answer === undefined ? undefined : answer.success === true ? "ok" : answer.errorCode).toBe(
					row.answer,
				);
				expect(t.lifecycle("a").filter((record) => record.type === "session_released")).toEqual(
					row.aReleased ? [released(session.sessionId)] : [],
				);
				if (row.attachments === null) return;
				const rows = await t.rig.listSessions("c");
				expect(rows.find((listed) => listed.sessionId === session.sessionId)?.attachments).toBe(row.attachments);
			});
		},
		30_000,
	);
});

const ids = (session: Opened) => ({ sessionId: session.sessionId, durableSessionId: session.durableSessionId });
