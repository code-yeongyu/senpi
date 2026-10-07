/**
 * `release_session` hands a session over only when it is quiet. On the in-process rig (real router,
 * registry, writer and `SessionManager`): a user bash, a prompt still in preflight, an admitted delivery
 * not yet written, or any other request for the session in flight refuses the release with the file
 * untouched; `interrupt` ends that work first; and a release that won a race leaves nothing for the
 * loser to write. The load-bearing assertion everywhere: no entry follows `session_released`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SESSION_RELEASED_ENTRY_TYPE } from "../../src/modes/rpc/session-release.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig, type FakeBindingExtras, type FakeTurn } from "./rpc-inprocess-host-support.ts";

const scratches: string[] = [];

afterEach(async () => {
	await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Rig = ReturnType<typeof createInProcessRig>;
type Handler = (command: RpcCommand) => Promise<void>;

async function quietSession(label: string, handler: (turn: () => FakeTurn) => Handler, extras?: FakeBindingExtras) {
	const dir = await mkdtemp(join(tmpdir(), `senpi-release-busy-${label}-`));
	scratches.push(dir);
	let current: FakeTurn | undefined;
	const turn = (): FakeTurn => {
		if (!current) throw new Error("no session yet");
		return current;
	};
	const rig = createInProcessRig(dir, undefined, handler(turn), extras);
	const session = opened(
		await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, `${label}.jsonl`), retain_on_disconnect: true }),
		0,
	);
	current = rig.turns.get(session.state.sessionFile);
	turn().start();
	turn().finish();
	await rig.drop("conn-a");
	return { rig, sessionId: session.sessionId, sessionPath: session.state.sessionFile, turn };
}

async function release(rig: Rig, sessionId: string, interrupt?: boolean): Promise<Record<string, unknown>> {
	const response = await rig.router.handle({
		type: "release_session",
		id: `rel-${Math.random()}`,
		sessionId,
		reason: "takeover",
		...(interrupt ? { interrupt } : {}),
	});
	await rig.settle();
	if (response === undefined) throw new Error("release_session answered nothing");
	return { ...response };
}

function entryKinds(sessionPath: string): string[] {
	return SessionManager.open(sessionPath)
		.getEntries()
		.map((entry) =>
			entry.type === "custom"
				? `custom:${entry.customType}`
				: entry.type === "message"
					? `message:${entry.message.role}${"cancelled" in entry.message && entry.message.cancelled ? ":cancelled" : ""}`
					: entry.type,
		);
}

function afterReleased(sessionPath: string): string[] | null {
	const kinds = entryKinds(sessionPath);
	const index = kinds.indexOf(`custom:${SESSION_RELEASED_ENTRY_TYPE}`);
	return index === -1 ? null : kinds.slice(index + 1);
}

const runsBash: (turn: () => FakeTurn) => Handler = (turn) => async (command) => {
	if (command.type === "bash") await turn().startBash();
};

describe("release_session refuses a session that is not quiet", () => {
	it("refuses while a user bash runs, then hands over once it ended, with nothing after session_released", async () => {
		// Given: a user bash in flight on another connection.
		const { rig, sessionId, sessionPath, turn } = await quietSession("bash", runsBash);
		await using _rig = rig;
		const bashReply = rig.send("conn-b", { type: "bash", id: "b1", sessionId, command: "sleep 3" });
		await rig.settle();
		const before = entryKinds(sessionPath);

		// When / Then: the release is refused, naming the bash and its request, and the file is untouched.
		expect(await release(rig, sessionId)).toMatchObject({
			success: false,
			error: "session_busy",
			errorData: { attachments: 0, busy: ["bash", "request"] },
		});
		expect(entryKinds(sessionPath)).toEqual(before);
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId, status: "open" })]);

		// When: the bash ends, then the session is released.
		turn().finishBash();
		await bashReply;
		expect(await release(rig, sessionId)).toMatchObject({ success: true, data: { released: true } });

		// Then: the bash was recorded before the release, and nothing was written after it.
		expect(entryKinds(sessionPath).slice(-2)).toEqual([
			"message:bashExecution",
			`custom:${SESSION_RELEASED_ENTRY_TYPE}`,
		]);
		expect(afterReleased(sessionPath)).toEqual([]);
	});

	it("with interrupt, aborts the bash, waits for it to be recorded, then releases", async () => {
		// Given: a user bash in flight on another connection.
		const { rig, sessionId, sessionPath } = await quietSession("bash-interrupt", runsBash);
		await using _rig = rig;
		const bashReply = rig.send("conn-b", { type: "bash", id: "b1", sessionId, command: "sleep 3" });
		await rig.settle();

		// When: the release interrupts.
		const reply = await release(rig, sessionId, true);
		await bashReply;

		// Then: the cancelled bash landed before session_released, which records the interrupt, and nothing follows.
		expect(reply).toMatchObject({ success: true, data: { released: true } });
		expect(entryKinds(sessionPath).slice(-2)).toEqual([
			"message:bashExecution:cancelled",
			`custom:${SESSION_RELEASED_ENTRY_TYPE}`,
		]);
		const released = SessionManager.open(sessionPath)
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === SESSION_RELEASED_ENTRY_TYPE);
		expect(released).toMatchObject({ data: { interrupted: true } });
		expect(afterReleased(sessionPath)).toEqual([]);
		expect(await rig.list()).toEqual([]);
	});

	it("refuses while a prompt is still in preflight after its command answered (prompt first)", async () => {
		// Given: a prompt whose command was routed and answered, but whose preflight has not started the run.
		let finishPrompt: (() => void) | undefined;
		const prompts = new Set<Promise<unknown>>();
		const { rig, sessionId, sessionPath, turn } = await quietSession(
			"prompt-first",
			(turnOf) => async (command) => {
				if (command.type !== "prompt") return;
				const call = new Promise<void>((resolve) => {
					finishPrompt = () => {
						turnOf().start();
						turnOf().finish();
						resolve();
					};
				});
				prompts.add(call);
				void call.finally(() => prompts.delete(call));
			},
			{ pendingPrompts: () => [...prompts] },
		);
		await using _rig = rig;
		await rig.send("conn-b", { type: "prompt", id: "p1", sessionId, message: "race" });
		const before = entryKinds(sessionPath);

		// When / Then: the release is refused as a turn about to start; nothing written, still hosted.
		expect(await release(rig, sessionId)).toMatchObject({
			success: false,
			error: "turn_active",
			errorData: { busy: ["prompt"] },
		});
		expect(entryKinds(sessionPath)).toEqual(before);
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId, status: "open" })]);

		// When: the prompt's turn runs to completion, the release goes through and nothing follows it.
		finishPrompt?.();
		await rig.settle();
		expect(turn().aborted).toBe(false);
		expect(await release(rig, sessionId)).toMatchObject({ success: true });
		expect(afterReleased(sessionPath)).toEqual([]);
	});

	it("refuses while another request for the session is still being handled (prompt first, command in flight)", async () => {
		// Given: a prompt command still inside its handler.
		let unblock: (() => void) | undefined;
		const { rig, sessionId } = await quietSession("prompt-in-flight", () => async (command) => {
			if (command.type === "prompt") await new Promise<void>((resolve) => (unblock = resolve));
		});
		await using _rig = rig;
		const promptReply = rig.send("conn-b", { type: "prompt", id: "p1", sessionId, message: "race" });
		await rig.settle();

		// When / Then: the release is refused for the in-flight request.
		expect(await release(rig, sessionId)).toMatchObject({
			success: false,
			error: "session_busy",
			errorData: { busy: ["request"] },
		});
		unblock?.();
		await promptReply;
	});

	it("when the release wins the race, the prompt routed after it is refused and never reaches the session", async () => {
		// Given: a quiet session and a binding that records every prompt it is handed.
		const handled: string[] = [];
		const { rig, sessionId, sessionPath } = await quietSession("release-first", () => async (command) => {
			handled.push(command.type);
		});
		await using _rig = rig;

		// When: the release and a prompt on another connection are dispatched in the same tick, release first.
		const releaseReply = rig.router.handle({ type: "release_session", id: "r1", sessionId, reason: "takeover" });
		const promptReply = rig.send("conn-b", { type: "prompt", id: "p1", sessionId, message: "race" });

		// Then: only one of them succeeds - the release - and nothing follows session_released.
		expect(await releaseReply).toMatchObject({ success: true, data: { released: true } });
		expect(await promptReply).toMatchObject({
			success: false,
			error: expect.stringMatching(/session_closing|unknown_session/),
		});
		expect(handled).toEqual([]);
		await rig.settle();
		expect(afterReleased(sessionPath)).toEqual([]);
	});

	it("refuses while an admitted delivery has not been written yet", async () => {
		const { rig, sessionId, sessionPath, turn } = await quietSession("delivery", () => async () => {});
		await using _rig = rig;
		turn().pendingDeliveries.push("d1");
		const before = entryKinds(sessionPath);
		expect(await release(rig, sessionId)).toMatchObject({
			success: false,
			error: "turn_active",
			errorData: { busy: ["delivery"] },
		});
		expect(entryKinds(sessionPath)).toEqual(before);
		turn().pendingDeliveries.splice(0);
		expect(await release(rig, sessionId)).toMatchObject({ success: true });
	});
});
