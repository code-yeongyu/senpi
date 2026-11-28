import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ObserverCensus } from "../../src/modes/rpc/host-observe-request.ts";

// senpi#7132: the supervisor reads a draining host's listing over its observer link. The read must neither attach to
// nor pin the host (`observe`, never `hold_host`), and a lost link must leave the read unanswered, never empty.
describe("the observer census", () => {
	function linked() {
		const census = new ObserverCensus();
		const link = new PassThrough();
		const written: Record<string, unknown>[] = [];
		link.on("data", (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) written.push(JSON.parse(line));
		});
		census.attach(link);
		return { census, link, written };
	}

	it("asks an observing read with only the workers flag and returns the host's own response", async () => {
		const { census, link, written } = linked();
		const wrote = once(link, "data");
		const asked = census.listSessions({ include_workers: true });
		await wrote;
		expect(written).toEqual([
			{ id: expect.any(String), type: "list_sessions", observe: true, include_workers: true },
		]);
		const response = {
			type: "response",
			id: written[0]?.id,
			command: "list_sessions",
			success: true,
			data: { sessions: [] },
		};
		expect(census.observe('{"type":"host_occupancy","holders":0}')).toBe(false);
		expect(census.observe(JSON.stringify(response))).toBe(true);
		expect(await asked).toEqual(response);
	});

	it("leaves a read unanswered when the link is lost or absent", async () => {
		const { census } = linked();
		const asked = census.listSessions({ hold_host: true } as { include_workers?: unknown });
		census.detach();
		expect(await asked).toBeUndefined();
		expect(await census.listSessions({})).toBeUndefined();
	});
});
