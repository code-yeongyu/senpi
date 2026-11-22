/**
 * senpi#6484: the host's record of a handle follows the session running behind it at the replacement itself, so what a
 * release or an unload answers is the session it acted on. Measured before this change: after `new_session`,
 * `switch_session`, `fork` or `clone` in the same folder the record kept the old session's file and id until a later
 * `list_sessions`, and a release sealed the new session's file while it answered the old session's path.
 */
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";
import {
	bindingSettled,
	overwriteStoredRecord,
	REPLACING_COMMANDS,
	replaceInSameFolder,
	sealedTranscripts,
	storedRecord,
} from "./rpc-replacement-follow-support.ts";

type Wire = Record<string, unknown>;
const send = (command: Wire): RpcCommand & { id: string } => command as unknown as RpcCommand & { id: string };
const RELEASES = [{ reason: "takeover" }, { reason: "move", moveId: "move-6484", target: "device-b" }] as const;

describe("the host's record of a handle after a replacement in the same folder (senpi#6484)", () => {
	it.each(REPLACING_COMMANDS)("names the new session as soon as %s has answered", async (replacing) => {
		await using host = await startReleaseHost(gatewayFixture().extension);

		const { stored, next } = await replaceInSameFolder(host, replacing);

		expect(stored).toEqual({ sessionPath: next.sessionFile, durableSessionId: next.sessionId });
	});

	it.each(REPLACING_COMMANDS.flatMap((replacing) => RELEASES.map((release) => ({ replacing, ...release }))))(
		"a release after $replacing (reason $reason) answers the file and id of the session it sealed",
		async ({ replacing, ...release }) => {
			await using host = await startReleaseHost(gatewayFixture().extension);
			const { handle, old, next } = await replaceInSameFolder(host, replacing);
			await bindingSettled(host, handle);

			const answer = await host.send(
				send({ type: "release_session", id: "release", sessionId: handle, ...release }),
			);

			expect(answer).toMatchObject({ success: true, data: { released: true } });
			expect(sealedTranscripts(dirname(old.sessionFile))).toEqual([next.sessionFile]);
			expect(answer.data).toMatchObject({ session_path: next.sessionFile, session_id: next.sessionId });
		},
	);

	it.each(REPLACING_COMMANDS)(
		"with a list_sessions between, a release after %s answers the sealed file",
		async (replacing) => {
			await using host = await startReleaseHost(gatewayFixture().extension);
			const { handle, old, next } = await replaceInSameFolder(host, replacing);
			await bindingSettled(host, handle);
			await host.send(send({ type: "list_sessions", id: "list" }));

			const answer = await host.send(
				send({ type: "release_session", id: "release", sessionId: handle, reason: "takeover" }),
			);

			expect(sealedTranscripts(dirname(old.sessionFile))).toEqual([next.sessionFile]);
			expect(answer.data).toMatchObject({ released: true, session_path: next.sessionFile });
		},
	);

	it("a release answers from the session it sealed, not from the host's stored record", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { handle, old, next } = await replaceInSameFolder(host, "new_session");
		await bindingSettled(host, handle);
		overwriteStoredRecord(host, handle, old.sessionFile, old.sessionId);

		const answer = await host.send(
			send({ type: "release_session", id: "release", sessionId: handle, reason: "takeover" }),
		);

		expect(sealedTranscripts(dirname(old.sessionFile))).toEqual([next.sessionFile]);
		expect(answer.data).toMatchObject({ released: true, session_path: next.sessionFile, session_id: next.sessionId });
		expect(storedRecord(host, handle)).toEqual({ sessionPath: undefined, durableSessionId: undefined });
	});

	it("an unload after a replacement answers the new session's file, and that file reopens as the new session", async () => {
		await using host = await startReleaseHost(gatewayFixture().extension);
		const { handle, next } = await replaceInSameFolder(host, "fork");
		await bindingSettled(host, handle);

		const unloaded = await host.send(send({ type: "unload_session", id: "unload", sessionId: handle }));

		expect(unloaded).toMatchObject({ success: true, data: { outcome: "unloaded", sessionPath: next.sessionFile } });
		const reopened = await host.attach(next.sessionFile);
		const state = await host.send(
			send({ type: "get_state", id: "state", sessionId: String((reopened.data as Wire).sessionId) }),
		);
		expect(state.data).toMatchObject({ sessionFile: next.sessionFile, sessionId: next.sessionId });
	});
});
