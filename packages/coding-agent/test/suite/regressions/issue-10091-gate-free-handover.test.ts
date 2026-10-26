// code-yeongyu/oh-my-openagent#10091: a runtime-identity handover asked of a busy host refused every new prompt on
// that host until the whole host was idle. A handover now never gates a command: it answers with its admission
// outcome at once, and new work keeps reaching its session whatever the operation's phase.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { createHostCore } from "../../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { inProcessRuntimeFactory } from "../rpc-inprocess-host-support.ts";

type WireRecord = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const BEGIN: WireRecord = {
	type: "begin_handover",
	operation_id: "op-1",
	if_instance_id: "host-a",
	if_generation: 2,
	target_runtime_build_id: "sha256:target",
	launch: { command: "senpi", args: [] },
	host_args: [],
	env: {},
};

async function hostCore() {
	const root = await mkdtemp(join(tmpdir(), "senpi-10091-gate-"));
	const cwd = join(root, "cwd");
	await mkdir(cwd);
	const { createRuntime, turns } = inProcessRuntimeFactory();
	const writer = new SessionEventWriter(() => {});
	const routed: string[] = [];
	const core = createHostCore(
		{
			agentDir: root,
			cwd,
			createRuntime,
			createBinding: async () => ({
				handle: async (command: object) => {
					const { id, type } = command as RpcCommand;
					routed.push(type);
					await writer.enqueueControl({ id, type: "response", command: type, success: true });
				},
				dispose: async () => {},
				cancelPendingExtensionUiRequests: () => {},
			}),
		},
		writer,
		[],
		{ idleEvictionMs: 1e12, emptyExitMs: 1e12 },
		undefined,
		{
			runtimeBuildId: "sha256:current",
			handover: {
				identity: () => ({ instanceId: "host-a", generation: 2, runtimeBuildId: "sha256:current" }),
				perform: async () => ({ ok: false, reason: "this test launches no successor" }),
				overlapEnabled: () => false,
				log: () => {},
			},
		},
	);
	const inbox: WireRecord[] = [];
	writer.registerConnection("c", {
		writeRaw: (chunk) => {
			for (const line of chunk.split("\n")) if (line !== "") inbox.push(JSON.parse(line) as WireRecord);
		},
		waitForBackpressure: async () => {},
	});
	let serial = 0;
	const request = async (command: WireRecord): Promise<WireRecord | undefined> => {
		const id = `r${++serial}`;
		await writer.withConnection("c", () => core.handle(JSON.stringify({ ...command, id })));
		await writer.flush();
		return inbox.find((record) => record.type === "response" && record.id === id);
	};
	const open = async (name: string): Promise<string> => {
		const opened = await request({ type: "open_session", cwd, sessionPath: join(root, name) });
		const data = opened?.data as { sessionId?: string } | undefined;
		if (data?.sessionId === undefined) throw new Error(`open failed: ${JSON.stringify(opened)}`);
		return data.sessionId;
	};
	cleanups.push(async () => {
		await core.router.dispose();
		await rm(root, { recursive: true, force: true });
	});
	return { request, routed, open, turns };
}

async function busyHost() {
	const host = await hostCore();
	const busy = await host.open("busy.jsonl");
	const idle = await host.open("idle.jsonl");
	for (const turn of host.turns.values()) {
		turn.start();
		break;
	}
	return { ...host, busy, idle };
}

describe("a runtime-identity handover asked of a busy host", () => {
	it("answers its admission outcome at once and keeps admitting new work", async () => {
		const host = await busyHost();

		const answer = await host.request(BEGIN);
		const prompt = await host.request({ type: "prompt", sessionId: host.idle, message: "new work" });

		expect(answer?.data).toMatchObject({
			operation_id: "op-1",
			phase: "migration_deferred",
			state: "handover_blocked",
			reason: "rollout_disabled",
		});
		expect(prompt).toMatchObject({ success: true });
		expect(host.routed).toContain("prompt");
	});
});

// A probe or an ensure's attach hold reads the protocol and holds nothing: it must not make an empty host's update
// look like it overlaps a client (every spawned handover was deferred by the rig's own unreleased ensure hold).
describe("a runtime-identity handover asked of a host that holds nothing", () => {
	it("proceeds past a connection that has only read the protocol", async () => {
		const host = await hostCore();
		await host.request({ type: "get_protocol_info" });

		const answer = await host.request(BEGIN);

		expect(answer?.data).toMatchObject({
			operation_id: "op-1",
			phase: "rolled_back",
			reason: "this test launches no successor",
		});
	});
});
