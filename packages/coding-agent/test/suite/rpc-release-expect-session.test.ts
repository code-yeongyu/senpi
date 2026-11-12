/**
 * senpi#6484, part 1: `release_session` carries the durable id of the session the caller expects
 * (`expectSessionId`) and refuses `session_mismatch`, releasing nothing, when the session behind the route is another.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { outgoingStateDir } from "../../src/core/session-move/extension-state.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import type { RouterContext } from "../../src/modes/rpc/session-router-context.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { heldTurn, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";
import { bindingSettled, replaceInSameFolder, sealedTranscripts } from "./rpc-replacement-follow-support.ts";

type Wire = Record<string, unknown>;
const send = (command: Wire): RpcCommand & { id: string } => command as unknown as RpcCommand & { id: string };
const MOVE = "move-6484" as MoveId;
const MOVE_FIELDS = { reason: "move", moveId: MOVE, target: "device-b" } as const;

describe("release_session { expectSessionId } (senpi#6484)", () => {
	it("refuses session_mismatch when the session behind the route was replaced, releases nothing and names nothing of the other session", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { handle, old, next } = await replaceInSameFolder(host, "new_session");
		await bindingSettled(host, handle);

		const answer = await host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: handle,
				...MOVE_FIELDS,
				expectSessionId: old.sessionId,
			}),
		);

		expect(answer).toMatchObject({
			success: false,
			errorCode: "session_mismatch",
			errorData: { expected: old.sessionId },
		});
		expect(JSON.stringify(answer)).not.toContain(next.sessionId);
		expect(JSON.stringify(answer)).not.toContain(next.sessionFile);
		expect(sealedTranscripts(dirname(old.sessionFile))).toEqual([]);
		expect(existsSync(outgoingStateDir(next.sessionFile, MOVE))).toBe(false);
		const state = await host.send(send({ type: "get_state", id: "state", sessionId: handle }));
		expect(state.data).toMatchObject({ sessionId: next.sessionId });
	}, 120_000);

	it("an interrupting release refused at the first compare takes nothing out of the running session", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { handle, old } = await replaceInSameFolder(host, "new_session");
		await bindingSettled(host, handle);
		const running = (Reflect.get(host.router, "context") as RouterContext).registry.peek(handle)?.runtime?.session;
		if (running === undefined) throw new Error("no session behind the handle");
		const started = nextEvent(running, "agent_start");
		await host.send(send({ type: "prompt", id: "work", sessionId: handle, message: "long work" }));
		await started;
		await host.send(send({ type: "follow_up", id: "queued", sessionId: handle, message: "after the work" }));
		const queued = running.pendingMessageCount;
		expect(queued).toBeGreaterThan(0);

		const answer = await host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: handle,
				...MOVE_FIELDS,
				interrupt: true,
				expectSessionId: old.sessionId,
			}),
		);

		expect(answer).toMatchObject({ success: false, errorCode: "session_mismatch" });
		expect((answer.errorData as Wire | undefined)?.interrupted).toBeUndefined();
		expect((answer.errorData as Wire | undefined)?.dropped).toBeUndefined();
		expect(running.isStreaming).toBe(true);
		expect(running.pendingMessageCount).toBe(queued);
		await host.send(send({ type: "abort", id: "stop", sessionId: handle }));
	}, 120_000);

	it("releases as before when the session behind the route is the expected one, and names it by file and id", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const s1 = await host.open("s1");

		const answer = await host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: s1.sessionId,
				reason: "takeover",
				expectSessionId: s1.session.sessionId,
			}),
		);

		expect(answer).toMatchObject({
			success: true,
			data: { released: true, session_path: s1.sessionPath, session_id: s1.session.sessionId },
		});
		expect(sealedTranscripts(dirname(s1.sessionPath))).toEqual([s1.sessionPath]);
	}, 120_000);

	it.each([
		{ name: "an empty string", value: "" },
		{ name: "a string over the identifier limit", value: "a".repeat(513) },
		{ name: "a string that is not a session id", value: "../s1" },
		{ name: "a number", value: 42 },
	])(
		"refuses $name as invalid_session_id and releases nothing",
		async ({ value }) => {
			await using host = await startReleaseHost(gatewayFixture().extension);
			const s1 = await host.open("s1");

			const answer = await host.send(
				send({
					type: "release_session",
					id: "release",
					sessionId: s1.sessionId,
					reason: "takeover",
					expectSessionId: value,
				}),
			);

			expect(answer).toMatchObject({ success: false, errorCode: "invalid_session_id" });
			expect(sealedTranscripts(dirname(s1.sessionPath))).toEqual([]);
			const state = await host.send(send({ type: "get_state", id: "state", sessionId: s1.sessionId }));
			expect(state).toMatchObject({ success: true });
		},
		120_000,
	);

	it("a replacement that lands while a move release waits for the extensions' export is refused at the second compare, with no staged folder left", async () => {
		let exportEntered!: () => void;
		const exporting = new Promise<void>((resolve) => {
			exportEntered = resolve;
		});
		let letExportGo!: () => void;
		const exportHeld = new Promise<void>((resolve) => {
			letExportGo = resolve;
		});
		let newSessionStarted!: () => void;
		const replacedSessionStarted = new Promise<void>((resolve) => {
			newSessionStarted = resolve;
		});
		const gateway = gatewayFixture();
		const extension: ExtensionFactory = (pi) => {
			gateway.extension(pi);
			pi.on("session_move_export", async (event) => {
				mkdirSync(join(event.dir, "probe"), { recursive: true });
				exportEntered();
				await exportHeld;
			});
			pi.on("session_start", (event) => {
				if (event.reason === "new") newSessionStarted();
			});
		};
		await using host = await startReleaseHost(extension);
		const s1 = await host.open("s1");
		const folder = dirname(s1.sessionPath);

		const releasing = host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: s1.sessionId,
				...MOVE_FIELDS,
				expectSessionId: s1.session.sessionId,
			}),
		);
		await exporting;
		const replaced = host.send(send({ type: "new_session", id: "replace", sessionId: s1.sessionId }), "replacer");
		await replacedSessionStarted;
		letExportGo();
		const answer = await releasing;

		expect(answer).toMatchObject({
			success: false,
			errorCode: "session_mismatch",
			errorData: { expected: s1.session.sessionId },
		});
		expect(sealedTranscripts(folder)).toEqual([]);
		// The attempt's folder, with what the export had written into it, is gone; the move's own folder stays, empty,
		// as after every refused move release.
		const stagedRoot = outgoingStateDir(s1.sessionPath, MOVE);
		expect(existsSync(stagedRoot) ? readdirSync(stagedRoot) : []).toEqual([]);
		expect(await replaced).toMatchObject({ success: true });
	}, 120_000);

	it("a mismatch found at the second compare after an interrupt hands back what was taken and says which session it came from", async () => {
		let exportEntered!: () => void;
		const exporting = new Promise<void>((resolve) => {
			exportEntered = resolve;
		});
		let letExportGo!: () => void;
		const exportHeld = new Promise<void>((resolve) => {
			letExportGo = resolve;
		});
		let newSessionStarted!: () => void;
		const replacedSessionStarted = new Promise<void>((resolve) => {
			newSessionStarted = resolve;
		});
		const gateway = gatewayFixture();
		const extension: ExtensionFactory = (pi) => {
			gateway.extension(pi);
			pi.on("session_move_export", async () => {
				exportEntered();
				await exportHeld;
			});
			pi.on("session_start", (event) => {
				if (event.reason === "new") newSessionStarted();
			});
		};
		await using host = await startReleaseHost(extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const s1 = await host.open("s1");
		const expected = s1.session.sessionId;
		const started = nextEvent(s1.session, "agent_start");
		await host.send(send({ type: "prompt", id: "work", sessionId: s1.sessionId, message: "long work" }));
		await started;
		await host.send(
			send({ type: "follow_up", id: "queued-1", sessionId: s1.sessionId, message: "first, after the work" }),
		);
		await host.send(
			send({ type: "follow_up", id: "queued-2", sessionId: s1.sessionId, message: "second, after the work" }),
		);

		const releasing = host.send(
			send({
				type: "release_session",
				id: "release",
				sessionId: s1.sessionId,
				...MOVE_FIELDS,
				interrupt: true,
				expectSessionId: expected,
			}),
		);
		await exporting;
		const replaced = host.send(send({ type: "new_session", id: "replace", sessionId: s1.sessionId }), "replacer");
		await replacedSessionStarted;
		letExportGo();
		const answer = await releasing;

		expect(answer).toMatchObject({
			success: false,
			errorCode: "session_mismatch",
			errorData: {
				expected,
				taken_from: expected,
				interrupted: true,
				dropped: { user_messages: ["first, after the work", "second, after the work"] },
			},
		});
		const state = await host.send(send({ type: "get_state", id: "state", sessionId: s1.sessionId }));
		const successor = String((state.data as Wire).sessionId);
		expect(successor).not.toBe(expected);
		expect(JSON.stringify(answer)).not.toContain(successor);
		expect(JSON.stringify(answer)).not.toContain(String((state.data as Wire).sessionFile));
		expect(sealedTranscripts(dirname(s1.sessionPath))).toEqual([]);
		expect(await replaced).toMatchObject({ success: true });
	}, 120_000);
});
