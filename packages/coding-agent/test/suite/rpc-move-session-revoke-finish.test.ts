/**
 * `move_session` op `finish` with a revoked answer (senpi#4003): once the receiver revoked its import, the sender's copy
 * is the only one that may be writable, so `revoked: true` wins over `accepted` and the sender takes the session back.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionMovedAwayError } from "../../src/core/session-move/ownership.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, importedOnB, move } from "./rpc-move-session-support.ts";

const reclaimedData = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> })
		.find((entry) => entry.customType === "session_reclaimed")?.data;

describe("move_session finish with a revoked answer (senpi#4003)", () => {
	it("#given the sender is still sealed for the move #when it finishes with accepted + revoked #then it reclaims the session writable, never moved", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-f1", ["keep me"]);
		await move(b, { op: "revoke", sessionPath: onB, moveId: "move-f1" });
		const answer = (await move(b, { op: "status", moveId: "move-f1", sessionPath: onB })).data;
		expect(answer).toEqual({ state: "accepted", revoked: true });

		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-f1", answer }),
		).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(customTypes(fixture.sessionPath)).toEqual(["session_released", "session_reclaimed"]);
		expect(reclaimedData(fixture.sessionPath)).toMatchObject({ move_id: "move-f1", reason: "revoked" });
		expect(readFileSync(fixture.sessionPath, "utf8")).toContain("keep me");
		expect(() =>
			SessionManager.open(fixture.sessionPath).appendMessage({ role: "user", content: "mine", timestamp: 9 }),
		).not.toThrow();
		expect(() => SessionManager.open(onB).appendMessage({ role: "user", content: "not here", timestamp: 9 })).toThrow(
			SessionMovedAwayError,
		);

		const before = readFileSync(fixture.sessionPath, "utf8");
		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-f1", answer }),
		).toMatchObject({ success: true, data: { ownership: "writable" } });
		expect(readFileSync(fixture.sessionPath, "utf8")).toBe(before);
	});

	it("#given the sender was already marked moved #when a revoked answer arrives #then finish refuses move_already_moved and changes nothing", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-f3");
		const accepted = { state: "accepted" };
		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-f3", answer: accepted }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
		await move(b, { op: "revoke", sessionPath: onB, moveId: "move-f3" });
		const before = readFileSync(fixture.sessionPath, "utf8");

		expect(
			await move(a, {
				op: "finish",
				sessionPath: fixture.sessionPath,
				moveId: "move-f3",
				answer: { state: "accepted", revoked: true },
			}),
		).toMatchObject({ success: false, error: "move_already_moved", errorData: { detail: expect.any(String) } });
		expect(readFileSync(fixture.sessionPath, "utf8")).toBe(before);
	});

	it("#given an import that was not revoked #when the sender finishes with plain accepted #then it is still marked moved", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-f2");
		const answer = (await move(b, { op: "status", moveId: "move-f2", sessionPath: onB })).data;
		expect(answer).toEqual({ state: "accepted" });

		expect(
			await move(a, { op: "finish", sessionPath: fixture.sessionPath, moveId: "move-f2", answer }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
		expect(customTypes(fixture.sessionPath)).toEqual(["session_released", "session_moved"]);
	});
});
