/**
 * senpi#6074: the interactive control endpoint admits input into a session this process no longer owns. A session
 * file that was moved away (or a copy sealed by `move_session revoke`, #4004) is read-only here, so input must be
 * refused up front with the same typed `session_moved_away` refusal the RPC host sends since #5906, before any
 * turn starts. Before, the endpoint answered `started` and the write guard refused the message only later.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_MOVED } from "../../../src/core/session-move/ownership.ts";
import { controlRequest } from "../../helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "../../helpers/session-control-fixture.ts";

const endpoints: EndpointFixture[] = [];

afterEach(async () => {
	for (const fixture of endpoints.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

async function endpoint(sealed: boolean): Promise<EndpointFixture> {
	const fixture = await startEndpoint();
	endpoints.push(fixture);
	if (sealed)
		fixture.harness.session.sessionManager.appendCustomEntry(SESSION_MOVED, {
			move_id: "move-6074",
			target: "",
			reason: "revoked",
			moved_at: "2026-11-06T00:00:00.000Z",
		});
	return fixture;
}

function sessionFileOf(fixture: EndpointFixture): string {
	const file = fixture.harness.session.sessionManager.getSessionFile();
	if (file === undefined) throw new Error("the harness session has no file");
	return file;
}

describe("input into a sealed session on the interactive control endpoint (senpi#6074)", () => {
	it.each(["prompt", "follow_up", "steer"] as const)(
		"#given a session sealed by a move #when %s is sent #then it is refused with session_moved_away and no turn starts",
		async (type) => {
			const fixture = await endpoint(true);
			const file = sessionFileOf(fixture);
			const before = readFileSync(file, "utf8");

			const reply = await controlRequest(fixture.socket, {
				id: `sealed-${type}`,
				type,
				message: "typed after the seal",
			});

			expect(reply.kind === "answered" && reply.record).toMatchObject({
				command: type,
				success: false,
				errorCode: "session_moved_away",
				errorData: { state: "moved" },
			});
			await fixture.harness.session.waitForSettledSessionWork();
			expect(fixture.harness.eventsOfType("agent_start")).toEqual([]);
			expect(readFileSync(file, "utf8")).toBe(before);
		},
	);

	it("#given a session this process owns #when a prompt is sent #then it is admitted and starts the turn", async () => {
		const fixture = await endpoint(false);

		const reply = await controlRequest(fixture.socket, {
			id: "owned-prompt",
			type: "prompt",
			message: "before any seal",
		});

		expect(reply.kind === "answered" && reply.record).toMatchObject({
			success: true,
			data: { disposition: "started" },
		});
		await fixture.harness.session.waitForSettledSessionWork();
		expect(fixture.harness.eventsOfType("agent_start").length).toBe(1);
	});
});
