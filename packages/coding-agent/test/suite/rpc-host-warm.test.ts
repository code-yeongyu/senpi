/**
 * senpi#2314: `warm` loads what the next `open_session` needs without opening a session. These run
 * the production router, the in-process registry and the real CLI runtime factory against a probe
 * extension that records every factory run (with the context it saw) and every `session_start`.
 */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { ClientOccupancy } from "../../src/modes/rpc/host-client-occupancy.ts";
import { isObservingRequest } from "../../src/modes/rpc/host-observe-request.ts";
import type { PreparableRuntimeFactory } from "../../src/modes/rpc/host-warm.ts";
import type { RpcCommand, RpcResponse } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";

type ProbeRecord = { event: "factory"; role: string | undefined; kind: string } | { event: "session_start" };
const PROBE_LOG = "__senpiHostWarmProbe";

const PROBE_SOURCE = `export default function (pi) {
	const log = (globalThis.${PROBE_LOG} ??= []);
	log.push({ event: "factory", role: pi.sessionContext.role, kind: pi.sessionKind });
	pi.on("session_start", () => {
		log.push({ event: "session_start" });
	});
}
`;

function probeLog(): ProbeRecord[] {
	const store = globalThis as unknown as Record<string, ProbeRecord[] | undefined>;
	store[PROBE_LOG] ??= [];
	return store[PROBE_LOG];
}

let scratch: string;
let cwd: string;
let agentDir: string;
let router: SessionCommandRouter | undefined;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-host-warm-"));
	cwd = join(scratch, "cwd");
	agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	probeLog().length = 0;
});

afterEach(async () => {
	await router?.dispose();
	router = undefined;
	await rm(scratch, { recursive: true, force: true });
});

async function realHost(): Promise<{
	router: SessionCommandRouter;
	registry: RpcSessionRegistry;
	opened: () => unknown;
}> {
	const probe = join(scratch, "probe.ts");
	await writeFile(probe, PROBE_SOURCE);
	const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--no-skills", "--no-context-files", "-e", probe]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1_000,
	});
	let latest: unknown;
	const writer = new SessionEventWriter((line) => {
		latest = JSON.parse(line);
	});
	router = new SessionCommandRouter(registry, writer, { cwd });
	return { router, registry, opened: () => latest };
}

function warmState(response: RpcResponse | undefined): string {
	if (response?.command !== "warm" || !response.success) throw new Error(`warm failed: ${JSON.stringify(response)}`);
	return response.data.state;
}

function warm(fields: Omit<Extract<RpcCommand, { type: "warm" }>, "type"> = {}): Extract<RpcCommand, { type: "warm" }> {
	return { type: "warm", ...fields };
}

function factoryRuns(): ProbeRecord[] {
	return probeLog().filter((record) => record.event === "factory");
}

describe("warm (senpi#2314)", () => {
	it("loads the profile's extensions without opening, listing or starting a session", async () => {
		const host = await realHost();

		expect(warmState(await host.router.handle(warm({ cwd, kind: "worker", context: { role: "child" } })))).toBe(
			"warmed",
		);

		expect(probeLog()).toEqual([{ event: "factory", role: "child", kind: "worker" }]);
		expect(host.registry.size).toBe(0);
		const listing = await host.router.handle({ type: "list_sessions", include_workers: true });
		expect(listing).toMatchObject({ success: true, data: { sessions: [] } });
	}, 60_000);

	it("answers a repeat as already_warm without running the factories again", async () => {
		const host = await realHost();
		const profile = warm({ cwd, kind: "worker", context: { role: "child" } });
		await host.router.handle(profile);

		expect(warmState(await host.router.handle(profile))).toBe("already_warm");

		expect(factoryRuns()).toHaveLength(1);
	}, 60_000);

	it("shares one load between concurrent warms of one profile", async () => {
		const host = await realHost();
		const profile = warm({ cwd, kind: "worker", context: { role: "member" } });

		const states = await Promise.all([host.router.handle(profile), host.router.handle(profile)]);

		expect(states.map(warmState)).toEqual(["warmed", "warmed"]);
		expect(factoryRuns()).toHaveLength(1);
	}, 60_000);

	it("loads a different context again and leaves the next open its own extension instance", async () => {
		const host = await realHost();
		await host.router.handle(warm({ cwd, kind: "worker", context: { role: "child" } }));
		expect(warmState(await host.router.handle(warm({ cwd, kind: "worker", context: { role: "dag_child" } })))).toBe(
			"warmed",
		);

		expect(
			await host.router.handle({ type: "open_session", cwd, kind: "worker", context: { role: "child" } }),
		).toBeUndefined();

		expect(host.opened()).toMatchObject({ command: "open_session", success: true });
		expect(probeLog()).toEqual([
			{ event: "factory", role: "child", kind: "worker" },
			{ event: "factory", role: "dag_child", kind: "worker" },
			{ event: "factory", role: "child", kind: "worker" },
			{ event: "session_start" },
		]);
	}, 60_000);

	it("refuses bad inputs with the open_session codes and does not remember a failed load", async () => {
		const host = await realHost();
		const missing = join(scratch, "later");

		const refusals = [
			await host.router.handle(warm({ kind: "bogus" as "worker" })),
			await host.router.handle(warm({ context: { "Bad-Key": "x" } })),
			await host.router.handle(warm({ cwd: "relative/dir" })),
			await host.router.handle(warm({ cwd: missing })),
		];

		expect(refusals.map((response) => (response?.success ? "ok" : response?.error.split(":")[0]))).toEqual([
			"invalid_session_kind",
			"invalid_session_context",
			"invalid_path",
			"warm_failed",
		]);
		await mkdir(missing);
		expect(warmState(await host.router.handle(warm({ cwd: missing })))).toBe("warmed");
	}, 60_000);

	it("advertises the warm capability only when the runtime can prepare", async () => {
		const host = await realHost();
		const plain: PreparableRuntimeFactory = async () => {
			throw new Error("no session is opened by this test");
		};
		const writer = new SessionEventWriter(() => {});
		const unwarmable = new SessionCommandRouter(new RpcSessionRegistry({ agentDir, createRuntime: plain }), writer, {
			cwd,
		});

		const capabilities = async (target: SessionCommandRouter) => {
			const info = await target.handle({ type: "get_protocol_info" });
			if (info?.command !== "get_protocol_info" || !info.success) throw new Error("no protocol info");
			return info.data.capabilities;
		};

		expect(await capabilities(host.router)).toContain("warm");
		expect(await capabilities(unwarmable)).not.toContain("warm");
		expect(warmState(await unwarmable.handle(warm({ cwd })))).toBe("unsupported");
		await unwarmable.dispose();
	}, 60_000);
});

describe("warm and the host's idle rules (senpi#2314)", () => {
	function heldWarmHost(idle: { now: () => number; emptyExitMs: number; onEmptyExit: () => void }) {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const createRuntime = Object.assign(
			async () => {
				throw new Error("no session is opened by this test");
			},
			{ prepare: () => held },
		) satisfies PreparableRuntimeFactory;
		const registry = new RpcSessionRegistry({ agentDir, createRuntime, now: idle.now });
		const writer = new SessionEventWriter(() => {});
		router = new SessionCommandRouter(registry, writer, { cwd }, undefined, {}, idle);
		return { router, release };
	}

	it("lets an empty host exit on its normal deadline while a warm is still loading", async () => {
		let now = 0;
		let exits = 0;
		const host = heldWarmHost({ now: () => now, emptyExitMs: 1_000, onEmptyExit: () => exits++ });
		host.router.sweepIdleSessions();

		now = 500;
		const pending = host.router.handle(warm({ cwd }));
		now = 1_000;
		host.router.sweepIdleSessions();

		expect(exits).toBe(1);
		host.release();
		expect(warmState(await pending)).toBe("warmed");
	});

	it("does not hold a drain open, and a draining host refuses to warm", async () => {
		let exits = 0;
		const host = heldWarmHost({ now: () => 0, emptyExitMs: Number.POSITIVE_INFINITY, onEmptyExit: () => exits++ });
		const pending = host.router.handle(warm({ cwd }));

		host.router.beginDrain();

		expect(exits).toBe(1);
		expect(await host.router.handle(warm({ cwd }))).toMatchObject({ success: false, error: "host_draining" });
		host.release();
		await pending;
	});

	it("never counts a warming connection as an attachment", () => {
		const occupancy = new ClientOccupancy(() => {});
		const client = new EventEmitter() as unknown as Socket;
		occupancy.admit(client);

		client.emit("data", Buffer.from(`${JSON.stringify({ type: "warm", context: { role: "child" } })}\n`));

		expect(isObservingRequest(JSON.stringify({ type: "warm" }))).toBe(true);
		expect({ attached: occupancy.attachedCount, unclassified: occupancy.unclassifiedCount }).toEqual({
			attached: 0,
			unclassified: 0,
		});
		client.emit("data", Buffer.from(`${JSON.stringify({ type: "open_session" })}\n`));
		expect(occupancy.attachedCount).toBe(1);
	});
});
