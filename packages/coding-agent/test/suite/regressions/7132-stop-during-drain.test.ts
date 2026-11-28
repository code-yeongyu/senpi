import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { writeHostSettings } from "../../../src/modes/rpc/host-daemon-state.ts";
import { settledOpportunisticHostGc } from "../../../src/modes/rpc/host-gc-pass.ts";
import { probeSessionCount } from "../../../src/modes/rpc/host-probe.ts";
import { readSessionCounts } from "../../../src/modes/rpc/host-status.ts";
import { withRpcKeyRoot } from "../../../src/modes/rpc/rpc-auth-client.ts";
import { stopHost } from "../../../src/modes/rpc/host-stop.ts";
import { readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { generationEnv, generationScratch } from "../../helpers/rpc-generation-support.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";

// senpi#7132: a normal (non-forced) stop must keep refusing while a draining host still holds a live session.
// The supervisor is the real one; its child is a stand-in that reports ONE attached session for as long as it lives
// and ignores the drain request, which is what a host with a turn still streaming looks like from outside.
const liveSession = join(import.meta.dirname, "../../fixtures/7132-live-session-supervisor.ts");
// The same supervisor around a child that lists nothing: a draining host that is in fact empty.
const noSession = join(import.meta.dirname, "../../fixtures/rpc-stopping-supervisor.ts");
const INSTANCE = "draining-generation";
const cleanups: Array<() => Promise<void>> = [];

async function rig(fixture = liveSession) {
	const qa = generationScratch("7132");
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	await writeHostSettings(paths, {
		socket: qa.socket,
		capabilities: [],
		coldStart: "persistent",
		idleExitMs: 60_000,
		generation: 0,
		instanceId: INSTANCE,
	});
	const supervisor = spawn(process.execPath, [fixture, "controlled", qa.socket, qa.agentDir], {
		env: {
			...hostSpawnEnv(),
			...generationEnv(qa),
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_RPC_HOST_INSTANCE_ID: INSTANCE,
		},
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	if (!supervisor.pid) throw new Error("missing supervisor pid");
	const exit = once(supervisor, "exit");
	let stderr = "";
	supervisor.stderr?.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const messages: string[] = [];
	supervisor.on("message", (message) => {
		if (typeof message === "object" && message !== null && "type" in message && typeof message.type === "string")
			messages.push(message.type);
	});
	/** Resolves when the supervisor (or its child) reports `type`; rejects if the supervisor exits first. */
	const seen = (type: string) =>
		new Promise<void>((resolve, reject) => {
			const check = () => {
				if (!messages.includes(type)) return;
				supervisor.off("message", check);
				supervisor.off("exit", failed);
				resolve();
			};
			const failed = () => reject(new Error(`supervisor exited before ${type}: ${stderr}`));
			supervisor.on("message", check);
			supervisor.once("exit", failed);
			check();
		});
	cleanups.push(async () => {
		if (supervisor.exitCode === null && supervisor.signalCode === null) {
			supervisor.kill("SIGTERM");
			supervisor.send("exit");
		}
		await exit;
		await settledOpportunisticHostGc(qa.agentDir);
		await rm(qa.root, { recursive: true, force: true });
	});
	await seen("ready");
	await writeHostRegistration(paths, {
		record: { pid: supervisor.pid, processStartTime: (await readProcessStartTime(supervisor.pid)) ?? null },
		socket: qa.socket,
		instanceId: INSTANCE,
		generation: 0,
		launchProfileId: "fixture",
	});
	return { qa, supervisor, messages, seen };
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(process.platform === "win32")(
	"a normal stop of a draining host that holds a live session (senpi#7132)",
	() => {
		it("refuses before the drain, as a control", async () => {
			const r = await rig();

			expect(await probeSessionCount(r.qa.socket, 5_000, { keyRoot: r.qa.agentDir })).toBe(1);
			expect(await stopHost({ socket: r.qa.socket, agentDir: r.qa.agentDir })).toEqual({
				action: "refuse",
				reason: "sessions_live",
			});
			expect(r.messages).not.toContain("child-stopping");
		});

		it("still counts the session and still refuses once the drain has begun", async () => {
			const r = await rig();
			r.supervisor.kill("SIGUSR1");
			await r.seen("child-draining");

			// What a stop decision reads: the host's own count, through both readers.
			expect.soft(await probeSessionCount(r.qa.socket, 5_000, { keyRoot: r.qa.agentDir })).toBe(1);
			// The client proves the host from the host's own agent dir, as `host stop` and `host status` do.
			expect.soft((await withRpcKeyRoot(r.qa.agentDir, () => readSessionCounts(r.qa.socket, true)))?.total).toBe(1);

			const stopping = stopHost({ socket: r.qa.socket, agentDir: r.qa.agentDir });
			// If the stop goes through, the child hears SIGTERM; let it leave so the stop call can settle.
			void r.seen("child-stopping").then(
				() => r.supervisor.send("exit"),
				() => {},
			);
			expect.soft(await stopping).toEqual({ action: "refuse", reason: "sessions_live" });
			expect.soft(r.messages).not.toContain("child-stopping");
		});

		it("stops a draining host that reports no session, without waiting for it to empty", async () => {
			const r = await rig(noSession);
			r.supervisor.kill("SIGUSR1");
			await r.seen("child-draining");

			// An answered zero, not an unanswered count: the stop goes through at once.
			expect(await probeSessionCount(r.qa.socket, 5_000, { keyRoot: r.qa.agentDir })).toBe(0);
			const leaving = r.seen("child-stopping").then(() => r.supervisor.send("exit"));
			expect(await stopHost({ socket: r.qa.socket, agentDir: r.qa.agentDir })).toEqual({
				action: "stopped",
				pid: r.supervisor.pid,
			});
			await leaving;
		});
	},
);
