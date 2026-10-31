import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { type FrozenAcceptedRoot, SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const LEGACY_KEYS = {
	tool_execution_start: ["args", "sessionId", "toolCallId", "toolName", "type"],
	tool_execution_end: ["isError", "result", "sessionId", "toolCallId", "toolName", "type"],
} as const;

// Part of #4272, RULING-13 (S06): a real in-process session drives the phase machine, and no legacy byte changes.
it("T3i legacy records keep their grammar while the real lane tracks the call through its phases", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const cuts: { readonly type: string; readonly root: FrozenAcceptedRoot }[] = [];
	const laneAccept = SessionAcceptanceLane.prototype.accept;
	vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
		this: SessionAcceptanceLane,
		...args: Parameters<SessionAcceptanceLane["accept"]>
	) {
		const ref = laneAccept.apply(this, args);
		const type = "type" in args[0] ? String(args[0].type) : "";
		if (ref && /^(tool_execution_(start|end)|turn_end)$/.test(type)) cuts.push({ type, root: this.freeze() });
		return ref;
	});
	await using host = await statusHost();
	await writeFile(join(host.cwd, "note.txt"), "legacy bytes\n");
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("calls");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	if (!lane) throw new Error("no real lane");
	const call = fauxToolCall("read", { path: join(host.cwd, "note.txt") }, { id: "call-read-1" });
	host.faux.setResponses([
		fauxAssistantMessage([call], { stopReason: "toolUse", timestamp: 1 }),
		fauxAssistantMessage("done", { timestamp: 2 }),
	]);
	const done = client.waitFor((record) => record.type === "agent_idle", 20_000);
	dataOf(await client.request({ type: "prompt", sessionId, message: "read it" }));
	await done;
	await host.writer.flush();

	const inbox: readonly WireRecord[] = client.inbox;
	const legacy = (type: keyof typeof LEGACY_KEYS) => inbox.filter((record) => record.type === type);
	expect(legacy("tool_execution_start").map((record) => Object.keys(record).sort())).toEqual([
		[...LEGACY_KEYS.tool_execution_start],
	]);
	expect(legacy("tool_execution_end").map((record) => Object.keys(record).sort())).toEqual([
		[...LEGACY_KEYS.tool_execution_end],
	]);
	expect(JSON.stringify(inbox)).not.toMatch(/runtimeItemKey|callsRoot|awaiting-execution|completed-awaiting-entry/);

	try {
		const started = cuts.find((cut) => cut.type === "tool_execution_start");
		const ended = cuts.find((cut) => cut.type === "tool_execution_end");
		if (!started || !ended) throw new Error("no execution cuts");
		const executing = await lane.readCurrentCalls(started.root);
		const completed = await lane.readCurrentCalls(ended.root);
		expect(executing.calls).toHaveLength(1);
		expect(executing.calls[0]?.runtimeItemKey).toMatch(new RegExp(`^${started.root.sessionEpoch}:\\d+\\.0$`));
		expect(executing.calls[0]).toMatchObject({
			toolCallId: "call-read-1",
			turnId: started.root.turnId,
			phase: "executing",
			requestedName: "read",
			resolvedName: "read",
			startSequence: started.root.sequence,
		});
		expect(executing.calls[0]?.owningMessageId).toEqual(expect.any(String));
		expect(executing.calls[0]?.raw).toBe(JSON.stringify(call.arguments));
		expect(completed.calls[0]).toMatchObject({
			runtimeItemKey: executing.calls[0]?.runtimeItemKey,
			phase: "completed-awaiting-entry",
			outcome: { kind: "result", isError: false, source: "execution_end" },
		});
		const turnEnd = cuts.find((cut) => cut.type === "turn_end");
		if (!turnEnd) throw new Error("no turn_end cut");
		expect((await lane.readCurrentCalls(turnEnd.root)).calls, "the result message settled the call").toEqual([]);
	} finally {
		for (const cut of cuts) lane.release(cut.root);
	}
}, 60_000);
