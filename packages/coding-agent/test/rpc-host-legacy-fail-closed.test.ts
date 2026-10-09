import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import { processMatchesPidFile, readProcessStartTime } from "../src/modes/app-server/daemon/process.ts";
import {
	ensureFixtureHost,
	LEGACY_VERSION,
	protocolInfo,
	readJson,
	type Sandbox,
	sandbox,
	sweepSandboxes,
} from "./helpers/rpc-host-daemon-sandbox.ts";

afterEach(sweepSandboxes, 60_000);

describe("legacy clients against the v2 daemon directory", () => {
	it("is invisible to the v2026.9.16-3 desktop reader", async () => {
		// The sandbox uses the CANONICAL socket, which is the path that makes that release's reader
		// look at `<agentDir>/rpc-host-daemon/host.pid` - the one file this layout never writes.
		const qa = await sandbox("desktop-reader", { canonicalSocket: true });
		await ensureFixtureHost(qa);

		expect(desktopReadManagedHost(qa.agentDir, qa.socket)).toBeUndefined();
	}, 20_000);

	it("makes the v2026.9.16-3 ensure fail closed instead of taking the host over", async () => {
		// D11/E9: the published v2026.9.16-3 ensure logic, replayed below, is what is deployed on user
		// machines while the new daemon rolls out. Its compatibility test is `serverVersion === VERSION`,
		// so it calls every new host incompatible - and the ONLY thing keeping it from stopping that
		// host is the absence of a pidfile it can parse. Its two side effects are spies: neither may fire.
		const qa = await sandbox("legacy-ensure", { canonicalSocket: true });
		const running = await ensureFixtureHost(qa);
		expect(VERSION).not.toBe(LEGACY_VERSION);
		const spawned: string[] = [];
		const stopped: number[] = [];

		const failure = await legacyEnsureHostLocked({
			qa,
			spawnHost: () => spawned.push(qa.socket),
			stopManagedHost: (pid) => stopped.push(pid),
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("unmanaged host");
		expect({ spawned, stopped }).toEqual({ spawned: [], stopped: [] });
		expect(await processMatchesPidFile(await generationRecord(qa))).toBe(true);
		expect(running.reused).toBe(false);
	}, 20_000);
});

/**
 * `readManagedHost` as the DEPLOYED v2026.9.16-3 desktop reads it
 * (`apps/server/src/provider/omo/omoSocketHost.ts`: `daemonDirectoryForSocket` -> flat `host.pid`,
 * accepted only with `{ pid: number, processStartTime: string }`). Copied rather than approximated:
 * this is the reader whose result arms that release's takeover, so it must not follow our refactors.
 */
function desktopReadManagedHost(
	agentDir: string,
	socketPath: string,
): { pid: number; processStartTime: string } | undefined {
	const daemonDir =
		resolve(socketPath) === resolve(join(agentDir, "rpc", "rpc.sock"))
			? join(agentDir, "rpc-host-daemon")
			: join(dirname(socketPath), "daemon");
	try {
		const value: unknown = JSON.parse(readFileSync(join(daemonDir, "host.pid"), "utf8").trim());
		const record = value as { pid?: unknown; processStartTime?: unknown };
		return typeof record?.pid === "number" && typeof record?.processStartTime === "string"
			? { pid: record.pid, processStartTime: record.processStartTime }
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * The decision half of `ensureHostLocked` as published in v2026.9.16-3
 * (`git show v2026.9.16-3:packages/coding-agent/src/modes/rpc/host-ensure.ts`), with its two side
 * effects replaced by spies. Copied rather than imported on purpose: this proves what the DEPLOYED
 * client does against today's directory layout, so it must not follow this branch's refactors.
 */
async function legacyEnsureHostLocked(args: {
	qa: Sandbox;
	spawnHost: () => void;
	stopManagedHost: (pid: number) => void;
}): Promise<void> {
	const pidFile = await readFile(join(args.qa.flatDir, "host.pid"), "utf8").then(
		(text) => JSON.parse(text) as { pid: number; processStartTime: string },
		() => undefined,
	);
	const answer = await protocolInfo(args.qa.socket).catch(() => undefined);
	const protocol = answer as { serverVersion?: string; capabilities?: string[] } | undefined;
	const compatible =
		protocol?.serverVersion === LEGACY_VERSION &&
		["multi_session", "extension_events"].every((capability) => protocol.capabilities?.includes(capability));
	if (compatible) return;
	const pidMatches = pidFile ? await processMatchesPidFile(pidFile, readProcessStartTime) : false;
	if (protocol && !pidMatches) throw new Error(`RPC socket ${args.qa.socket} is owned by an unmanaged host`);
	if (pidFile && pidMatches) args.stopManagedHost(pidFile.pid);
	args.spawnHost();
}

/** The record the pointer names, read the way a client reads it: pointer first, then the generation. */
async function generationRecord(qa: Sandbox): Promise<{ pid: number; processStartTime: string }> {
	const pointer = await readJson(join(qa.daemonDir, "host.pid"));
	return (await readJson(join(qa.daemonDir, pointer.generation_dir as string, "host.pid"))) as unknown as {
		pid: number;
		processStartTime: string;
	};
}
