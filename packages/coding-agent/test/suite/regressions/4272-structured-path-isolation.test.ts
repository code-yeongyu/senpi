import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// senpi#4439 review LOW-4: the structured lane runs before the legacy listeners, so a throw on the structured path
// must cost only the structured record and the compact component, never legacy or extension delivery of the event.
it("a throwing structured receiver leaves legacy and extension delivery whole and compact state unavailable", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("isolation");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	const session = entry?.runtime?.session;
	if (!lane || !session) throw new Error("no real lane");
	let thrown = 0;
	const stop = host.writer.structuredLanes.observe(sessionId, () => {
		thrown += 1;
		throw new Error("structured receiver failed");
	});
	const seen: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end") seen.push(event.message.role);
	});
	try {
		host.faux.setResponses([fauxAssistantMessage("legacy survives the receiver", { timestamp: 1 })]);
		const done = client.waitFor((record) => record.type === "agent_idle", 15_000);
		dataOf(await client.request({ type: "prompt", sessionId, message: "go" }));
		await done;
		await host.writer.flush();
	} finally {
		unsubscribe();
		stop();
	}
	expect(thrown).toBeGreaterThan(0);
	expect(seen).toEqual(expect.arrayContaining(["user", "assistant"]));
	const ends = client.inbox.filter((record) => record.type === "message_end");
	expect(JSON.stringify(ends)).toContain("legacy survives the receiver");
	const root = lane.freeze();
	try {
		expect(root.current).toBeUndefined();
	} finally {
		lane.release(root);
	}
}, 60_000);
