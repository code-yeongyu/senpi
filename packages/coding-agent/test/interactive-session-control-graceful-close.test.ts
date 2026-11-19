import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { controlData } from "./helpers/session-control-client.ts";
import { type EndpointFixture, startEndpoint } from "./helpers/session-control-fixture.ts";

// oh-my-openagent#14313: a terminal's own session closes only gracefully, never over unsent composer text, and the
// terminal exits by itself once the close has answered.

const fixtures: EndpointFixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.endpoint.dispose();
		fixture.harness.cleanup();
	}
});

async function endpoint(): Promise<EndpointFixture> {
	const fixture = await startEndpoint();
	fixtures.push(fixture);
	return fixture;
}

describe("unload_session on a terminal's control endpoint", () => {
	it("advertises the command and the capability", async () => {
		const fixture = await endpoint();
		const info = (await controlData(fixture.socket, { type: "get_protocol_info" })) as {
			capabilities: string[];
			commands: string[];
		};
		expect(info.capabilities).toContain("unload_graceful");
		expect(info.commands).toContain("unload_session");
	});

	it("closes an idle session gracefully, records the clean stop and asks the terminal to exit", async () => {
		const fixture = await endpoint();
		const answer = await controlData(fixture.socket, { type: "unload_session", graceful: true });
		expect(answer).toMatchObject({
			outcome: "unloaded",
			dropped: { deliveries: [], user_messages: [] },
			graceful: { turn: 0, stopped: { wake_sources: [] } },
		});
		expect(fixture.closes.count).toBe(1);
		expect(fixture.harness.session.closedOnRequest).toBe(true);
		const sessionFile = fixture.harness.session.sessionFile;
		if (sessionFile === undefined) throw new Error("the fixture session has no file");
		const types = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => (JSON.parse(line) as { customType?: string }).customType);
		expect(types).toContain("session-closed");
		expect(types).not.toContain("interrupted-run");
	});

	it("refuses while the composer holds unsent text and changes nothing", async () => {
		const fixture = await endpoint();
		fixture.setDraft(true);
		expect(await controlData(fixture.socket, { type: "unload_session", graceful: true })).toMatchObject({
			outcome: "refused",
			reason: "composer_draft",
		});
		expect(fixture.closes.count).toBe(0);
		expect(fixture.harness.session.closedOnRequest).toBe(false);
	});

	it("refuses a close that is not graceful", async () => {
		const fixture = await endpoint();
		expect(await controlData(fixture.socket, { type: "unload_session" })).toMatchObject({
			outcome: "refused",
			reason: "unsupported",
		});
		expect(fixture.closes.count).toBe(0);
	});
});
