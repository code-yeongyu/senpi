/**
 * A host request belongs to the connection that offered `session_relocation`: on a REAL in-process host with two
 * clients attached to one session, only the offering client is asked, and only its answer counts.
 */
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCEPT, DESKTOP, OFFERS, relocationHost } from "./rpc-relocate-session-host-support.ts";

describe("relocation host requests go to the offering connection only", () => {
	it("an older client attached to the same session receives no host_request and no relocation_due", async () => {
		// Given: the desktop offers relocation; an older client that never offered it is attached too.
		const { host, dueSeen, work, recordsOn } = await relocationHost({ otherClient: { name: "older-client" } });
		await using _host = host;

		// When: the agent asks to move and the turn ends.
		await work();
		await dueSeen;

		// Then: exactly one request and one due notice, both on the desktop's connection only.
		expect(recordsOn(DESKTOP, "host_request")).toHaveLength(1);
		expect(recordsOn(DESKTOP, "relocation_due")).toHaveLength(1);
		expect(recordsOn("older-client", "host_request")).toEqual([]);
		expect(recordsOn("older-client", "relocation_due")).toEqual([]);
	});

	it("asks the connection attached to THIS session first, not one that opened another session earlier", async () => {
		// Given: a window opens another session before the desktop attaches here, and only later attaches here too.
		const { host, dueSeen, work, recordsOn } = await relocationHost({
			beforeDesktop: async (rig, sessionPath) => {
				await rig.attach(join(dirname(sessionPath), "elsewhere.jsonl"), "early-window", OFFERS);
			},
			otherClient: { name: "early-window", capabilities: OFFERS },
		});
		await using _host = host;

		// When: the agent asks to move.
		await work();
		await dueSeen;

		// Then: the desktop, attached to this session first, is the one asked and told.
		expect(recordsOn(DESKTOP, "host_request")).toHaveLength(1);
		expect(recordsOn("early-window", "host_request")).toEqual([]);
		expect(recordsOn(DESKTOP, "relocation_due")).toHaveLength(1);
	});

	it("refuses a host_response from a connection that was not asked; the offering client's answer still counts", async () => {
		// Given: a second client that also offers relocation tries to answer first, then the desktop answers.
		const { host, dueSeen, work, replies } = await relocationHost({
			otherClient: { name: "second-window", capabilities: ["session_relocation"] },
			answer: (_request, reply) => {
				reply("second-window", { accepted: false, reason: "hijack", detail: "not mine" });
				reply(DESKTOP, ACCEPT);
			},
		});
		await using _host = host;

		// When: the agent asks to move.
		await work();
		const notice = await dueSeen;

		// Then: the stray answer is refused, typed; the desktop's accept stands and the move is due.
		expect(replies()).toEqual([
			expect.objectContaining({ connection: "second-window", success: false, error: "not_offering_connection" }),
			expect.objectContaining({ connection: DESKTOP, success: true }),
		]);
		expect(notice).toMatchObject({ moveId: "mv-a1", target: "Studio" });
	});
});
