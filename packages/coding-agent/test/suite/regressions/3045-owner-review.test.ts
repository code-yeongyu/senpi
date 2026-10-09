import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { readHostCrashRecords } from "../../../src/modes/rpc/host-crash-record.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	generationPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import {
	type HostLifetimeOwner,
	readHostOwner,
	writeHostOwner,
	writeHostSettings,
} from "../../../src/modes/rpc/host-daemon-state.ts";
import { hostLaunchProfile } from "../../../src/modes/rpc/protocol-identity.ts";
import {
	type GenerationScratch,
	generationEnv,
	generationScratch,
	JsonlPeer,
} from "../../helpers/rpc-generation-support.ts";
import { processAlive } from "../../helpers/spawned-host-reaper.ts";

const fixture = join(import.meta.dirname, "../../fixtures/rpc-owner-review-clock.ts");
const children: Array<{ child: ChildProcess; command: string; exited: Promise<unknown> }> = [];
const hostPids = new Set<number>();
const roots: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];

class Messages {
	readonly seen: Record<string, unknown>[] = [];
	private readonly child: ChildProcess;

	constructor(child: ChildProcess) {
		this.child = child;
		child.on("message", (value: unknown) => {
			if (typeof value !== "object" || value === null) return;
			const record = { ...value };
			this.seen.push(record);
			if ("type" in record && record.type === "host" && "pid" in record && typeof record.pid === "number") {
				hostPids.add(record.pid);
			}
		});
	}

	wait(type: string, after = 0): Promise<Record<string, unknown>> {
		const found = this.seen.slice(after).find((record) => record.type === type);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				this.child.off("message", onMessage);
				this.child.off("exit", onExit);
			};
			const onMessage = () => {
				const record = this.seen.slice(after).find((candidate) => candidate.type === type);
				if (!record) return;
				cleanup();
				resolve(record);
			};
			const onExit = () => {
				cleanup();
				reject(new Error(`supervisor exited before ${type}`));
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`missing ${type}`));
			}, 20_000);
			this.child.on("message", onMessage);
			this.child.once("exit", onExit);
		});
	}
}

function launch(args: string[], env: NodeJS.ProcessEnv) {
	const child = spawn(process.execPath, [fixture, ...args], { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
	if (child.pid === undefined) throw new Error("fixture did not start");
	const command = execFileSync("ps", ["-p", String(child.pid), "-o", "command="], { encoding: "utf8" }).trim();
	const exited = once(child, "exit");
	children.push({ child, command, exited });
	return { child, messages: new Messages(child), exited };
}

async function rig(owned = true, watchMode = "normal") {
	const qa = generationScratch("rv");
	roots.push(qa);
	const env = { ...process.env, ...generationEnv(qa), SENPI_CODING_AGENT_DIR: qa.agentDir };
	const owner = owned ? launch(["owner"], env) : undefined;
	let identity: HostLifetimeOwner | null = null;
	if (owner) {
		const message = await owner.messages.wait("owner");
		const value = message.owner;
		if (
			typeof value !== "object" ||
			value === null ||
			!("pid" in value) ||
			!("startTime" in value) ||
			typeof value.pid !== "number" ||
			typeof value.startTime !== "string"
		)
			throw new Error("bad owner identity");
		identity = { pid: value.pid, startTime: value.startTime };
	}
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	await createDaemonDirectories(paths);
	const instanceId = "owner-review";
	await writeHostSettings(paths, {
		socket: qa.socket,
		capabilities: [],
		coldStart: "transient",
		idleExitMs: 60_000,
		generation: 0,
		instanceId,
	});
	const generation = generationPaths(paths, instanceId);
	await writeHostOwner(generation.dir, identity);
	const supervisor = launch(
		["supervisor", qa.socket, qa.agentDir, generation.dir, String(identity?.pid ?? 0), watchMode],
		{ ...env, SENPI_RPC_HOST_INSTANCE_ID: instanceId },
	);
	if (supervisor.child.pid === undefined) throw new Error("no supervisor pid");
	await writeHostRegistration(paths, {
		record: {
			pid: supervisor.child.pid,
			processStartTime: (await readProcessStartTime(supervisor.child.pid)) ?? null,
		},
		socket: qa.socket,
		instanceId,
		generation: 0,
		launchProfileId: hostLaunchProfile(
			["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-prompt-templates"],
			process.cwd(),
		).profile_id,
	});
	await supervisor.messages.wait("ready");
	const observer = await JsonlPeer.connect(qa.socket);
	peers.push(observer);
	expect(await observer.request({ id: "observe", type: "get_protocol_info", observe: true })).toMatchObject({
		success: true,
	});
	const clock = async (now: number, tick = true) => {
		const checked = supervisor.messages.wait(tick ? "checked" : "clock", supervisor.messages.seen.length);
		supervisor.child.send({ now, tick });
		return checked;
	};
	const exitOwner = async () => {
		if (!owner) throw new Error("no owner");
		owner.child.send("exit");
		await owner.exited;
	};
	return { qa, paths, generation, instanceId, supervisor, clock, exitOwner, observer };
}

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const entry of children.splice(0).reverse()) {
		if (entry.child.exitCode !== null || entry.child.signalCode !== null || entry.child.pid === undefined) continue;
		const command = execFileSync("ps", ["-p", String(entry.child.pid), "-o", "command="], {
			encoding: "utf8",
		}).trim();
		expect(command).toBe(entry.command);
		entry.child.kill("SIGTERM");
		await entry.exited;
		expect(processAlive(entry.child.pid)).toBe(false);
	}
	for (const pid of hostPids) expect(processAlive(pid), `host ${pid} cleanup`).toBe(false);
	hostPids.clear();
	for (const qa of roots.splice(0)) await rm(qa.root, { recursive: true, force: true });
}, 30_000);

// #3045: deterministic OS-error and clock probes against the real supervisor and host.
describe.skipIf(process.platform === "win32")("owner review regressions", () => {
	it("starts an unowned host without opening an owner watcher even when watches are exhausted", async () => {
		const r = await rig(false, "throw");
		expect(r.supervisor.messages.seen.filter((event) => event.type === "watch")).toHaveLength(0);
		expect((await r.clock(30_000)).exit).toBe(false);
		expect(r.supervisor.messages.seen.filter((event) => event.type === "probe")).toHaveLength(0);
		expect(await readHostOwner(r.generation.dir)).toBeNull();
	});

	it("starts with an exhausted watcher and detects owner death through polling", async () => {
		const r = await rig(true, "throw");
		expect(r.supervisor.messages.seen.filter((event) => event.type === "watch")).toHaveLength(1);
		await r.exitOwner();
		expect((await r.clock(0)).exit).toBe(false);
		expect((await r.clock(2_000)).exit).toBe(true);
		await r.supervisor.exited;
		expect(r.supervisor.messages.seen.some((event) => event.type === "probe")).toBe(true);
	});

	it("waits the full two seconds and removes registration through owner_gone shutdown", async () => {
		const r = await rig();
		await r.exitOwner();
		expect((await r.clock(0)).exit).toBe(false);
		expect((await r.clock(1_999)).exit).toBe(false);
		expect((await r.clock(2_000)).exit).toBe(true);
		await r.supervisor.exited;
		expect(readHostCrashRecords(r.paths.dir)).toContainEqual(
			expect.objectContaining({
				generation: r.instanceId,
				detection: "engine_stop",
				reason: "owner_gone",
			}),
		);
		for (const path of [r.paths.pointerFile, r.paths.settingsFile, r.generation.dir]) {
			await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("resets grace for an attachment entirely between supervisor ticks", async () => {
		const r = await rig();
		await r.exitOwner();
		expect((await r.clock(0)).exit).toBe(false);
		await r.clock(1_500, false);
		const peer = await JsonlPeer.connect(r.qa.socket);
		peers.push(peer);
		await peer.request({ id: "attach", type: "get_protocol_info" });
		const detached = r.supervisor.messages.wait("detached", r.supervisor.messages.seen.length);
		peer.destroy();
		await detached;
		expect((await r.clock(2_000)).exit).toBe(false);
		expect((await r.clock(3_999)).exit).toBe(false);
		expect((await r.clock(4_000)).exit).toBe(true);
		await r.supervisor.exited;
	});

	it("exits within owner grace despite status reads every 500 milliseconds", async () => {
		const r = await rig();
		await r.exitOwner();
		expect((await r.clock(0)).exit).toBe(false);
		for (const now of [500, 1_000, 1_500, 1_999]) {
			await r.clock(now, false);
			const peer = await JsonlPeer.connect(r.qa.socket);
			peers.push(peer);
			expect(
				await peer.request({ id: `status-info-${now}`, type: "get_protocol_info", observe: true }),
			).toMatchObject({
				success: true,
			});
			expect(
				await peer.request({ id: `status-sessions-${now}`, type: "list_sessions", observe: true }),
			).toMatchObject({
				success: true,
			});
			const detached = r.supervisor.messages.wait("detached", r.supervisor.messages.seen.length);
			peer.destroy();
			await detached;
			expect((await r.clock(now)).exit).toBe(false);
		}
		expect((await r.clock(2_000)).exit).toBe(true);
		await r.supervisor.exited;
	});

	it("resets grace for an unclassified peer dropped entirely between ticks", async () => {
		const r = await rig();
		await r.exitOwner();
		expect((await r.clock(0)).exit).toBe(false);
		await r.clock(1_500, false);
		const peer = await JsonlPeer.connect(r.qa.socket);
		peers.push(peer);
		const detached = r.supervisor.messages.wait("detached", r.supervisor.messages.seen.length);
		peer.destroy();
		await detached;
		expect((await r.clock(2_000)).exit).toBe(false);
		expect((await r.clock(3_999)).exit).toBe(false);
		expect((await r.clock(4_000)).exit).toBe(true);
		await r.supervisor.exited;
	});

	it("resets grace through refresh when an existing observer becomes attached between ticks", async () => {
		const r = await rig();
		await r.exitOwner();
		expect((await r.clock(0)).exit).toBe(false);
		await r.clock(1_500, false);
		expect(await r.observer.request({ id: "attach-existing", type: "get_protocol_info" })).toMatchObject({
			success: true,
		});
		const detached = r.supervisor.messages.wait("detached", r.supervisor.messages.seen.length);
		r.observer.destroy();
		await detached;
		expect((await r.clock(2_000)).exit).toBe(false);
		expect((await r.clock(3_999)).exit).toBe(false);
		expect((await r.clock(4_000)).exit).toBe(true);
		await r.supervisor.exited;
	});

	it("backs off live pipeless owner probes without exceeding a five second detection cadence", async () => {
		const r = await rig();
		for (let now = 0; now <= 27_000; now += 1_000) expect((await r.clock(now)).exit).toBe(false);
		const probes = r.supervisor.messages.seen.filter((event) => event.type === "probe");
		expect(probes.length).toBeGreaterThanOrEqual(6);
		expect(probes.length).toBeLessThanOrEqual(9);
		for (let index = 1; index < probes.length; index++) {
			expect(Number(probes[index].now) - Number(probes[index - 1].now)).toBeLessThanOrEqual(5_000);
		}
	});
});
