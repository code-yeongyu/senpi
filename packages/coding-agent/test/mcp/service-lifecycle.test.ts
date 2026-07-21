import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getMcpService,
	registerToolsPreservingActiveSet,
	resetMcpServiceForTests,
} from "../../src/core/extensions/builtin/mcp/service.ts";
import {
	assertAlive,
	attach,
	awaitMcpConnected,
	cleanupRoots,
	fakePi,
	makeRoot,
	readCounter,
	requiredPid,
	setConfig,
	stdioServer,
	tool,
	waitForCondition,
	writeProjectConfig,
} from "./fixtures/service-lifecycle.ts";
import { assertProcessDead, stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

describe("McpService session lifecycle", () => {
	it("reuses a live fixture connection across sequential sessions with the same config", async () => {
		const root = makeRoot("reuse", cleanupTasks);
		const counterFile = join(root.agentDir, "shared-spawns.txt");
		setConfig(root, {
			shared: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]),
		});
		const service = getMcpService();

		await attach(service, root, "startup");
		await awaitMcpConnected(service, "shared");
		const firstPid = service.getConnection("shared")?.getRootPid();
		await service.handleSessionShutdown({ type: "session_shutdown", reason: "new" });
		await attach(service, root, "new");
		const secondPid = service.getConnection("shared")?.getRootPid();

		expect(firstPid).toEqual(expect.any(Number));
		expect(secondPid).toBe(firstPid);
		expect(await readCounter(counterFile)).toBe(1);
		expect(service.getServerSnapshots()).toMatchObject([
			{ name: "shared", lifecycleState: "connected", pid: firstPid, configState: "enabled" },
		]);
	});

	it("disposes on reload and a subsequent session respawns the server", async () => {
		const root = makeRoot("reload", cleanupTasks);
		const counterFile = join(root.agentDir, "reload-spawns.txt");
		setConfig(root, {
			reloadable: stdioServer(["--tools", "1", "--spawn-counter-file", counterFile]),
		});
		const serviceBeforeReload = getMcpService();

		await attach(serviceBeforeReload, root, "startup");
		await awaitMcpConnected(serviceBeforeReload, "reloadable");
		const firstPid = requiredPid(serviceBeforeReload, "reloadable");
		await serviceBeforeReload.handleSessionShutdown({ type: "session_shutdown", reason: "reload" });
		await assertProcessDead(firstPid);

		const serviceAfterReload = getMcpService();
		await attach(serviceAfterReload, root, "reload");
		await awaitMcpConnected(serviceAfterReload, "reloadable");
		const secondPid = requiredPid(serviceAfterReload, "reloadable");

		expect(serviceAfterReload).not.toBe(serviceBeforeReload);
		expect(secondPid).not.toBe(firstPid);
		expect(await readCounter(counterFile)).toBe(2);
		await assertAlive(secondPid);
	});

	it("replaces only the server whose config hash changes between kept sessions", async () => {
		const root = makeRoot("config-edit", cleanupTasks);
		const changedCounter = join(root.agentDir, "changed-spawns.txt");
		const stableCounter = join(root.agentDir, "stable-spawns.txt");
		setConfig(root, {
			changed: stdioServer(["--tools", "1", "--spawn-counter-file", changedCounter]),
			stable: stdioServer(["--tools", "1", "--spawn-counter-file", stableCounter]),
		});
		const service = getMcpService();

		await attach(service, root, "startup");
		await awaitMcpConnected(service, "changed");
		await awaitMcpConnected(service, "stable");
		const changedPidBefore = requiredPid(service, "changed");
		const stablePidBefore = requiredPid(service, "stable");
		await service.handleSessionShutdown({ type: "session_shutdown", reason: "new" });

		setConfig(root, {
			changed: stdioServer(["--tools", "2", "--spawn-counter-file", changedCounter]),
			stable: stdioServer(["--tools", "1", "--spawn-counter-file", stableCounter]),
		});
		await attach(service, root, "new");
		await awaitMcpConnected(service, "changed");
		const changedPidAfter = requiredPid(service, "changed");
		const stablePidAfter = requiredPid(service, "stable");

		expect(changedPidAfter).not.toBe(changedPidBefore);
		expect(stablePidAfter).toBe(stablePidBefore);
		expect(await readCounter(changedCounter)).toBe(2);
		expect(await readCounter(stableCounter)).toBe(1);
		await assertProcessDead(changedPidBefore);
		await assertAlive(stablePidAfter);
	});

	it("does not spawn disabled or untrusted servers and disposes removed live servers", async () => {
		const root = makeRoot("blocked-removed", cleanupTasks);
		const liveCounter = join(root.agentDir, "live-spawns.txt");
		const disabledCounter = join(root.agentDir, "disabled-spawns.txt");
		const untrustedCounter = join(root.cwd, "untrusted-spawns.txt");
		setConfig(root, {
			disabled: { ...stdioServer(["--spawn-counter-file", disabledCounter]), enabled: false },
			live: stdioServer(["--tools", "1", "--spawn-counter-file", liveCounter]),
		});
		writeProjectConfig(root.cwd, {
			untrusted: stdioServer(["--spawn-counter-file", untrustedCounter]),
		});
		const service = getMcpService();

		await attach(service, root, "startup", false);
		await awaitMcpConnected(service, "live");
		const livePid = requiredPid(service, "live");
		expect(await readCounter(liveCounter)).toBe(1);
		await expect(readCounter(disabledCounter)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readCounter(untrustedCounter)).rejects.toMatchObject({ code: "ENOENT" });
		expect(service.getConnection("disabled")).toBeUndefined();
		expect(service.getConnection("untrusted")).toBeUndefined();

		setConfig(root, {
			disabled: { ...stdioServer(["--spawn-counter-file", disabledCounter]), enabled: false },
		});
		await attach(service, root, "new", false);

		await assertProcessDead(livePid);
		expect(service.getServerSnapshots().map((snapshot) => [snapshot.name, snapshot.configState])).toEqual([
			["disabled", "disabled"],
			["untrusted", "untrusted"],
		]);
	});

	it("surfaces transport creation failures in server snapshots without spawning a process", async () => {
		const root = makeRoot("create-failure", cleanupTasks);
		setConfig(root, {
			needsAuth: {
				type: "http",
				url: "http://127.0.0.1:1/mcp",
				auth: "bearer",
				connectTimeoutMs: 200,
			},
		});
		const service = getMcpService();

		await attach(service, root, "startup");
		await waitForCondition(() => service.getConnection("needsAuth")?.state === "degraded", 10_000);

		expect(service.getConnection("needsAuth")?.getRootPid()).toBeNull();
		expect(service.getServerSnapshots()).toMatchObject([
			{
				name: "needsAuth",
				configState: "enabled",
				lifecycleState: "degraded",
				pid: null,
				lastError: expect.stringContaining("bearerTokenEnv"),
			},
		]);
	});

	it("disposes all live fixture processes on quit", async () => {
		const root = makeRoot("quit", cleanupTasks);
		const firstCounter = join(root.agentDir, "first-spawns.txt");
		const secondCounter = join(root.agentDir, "second-spawns.txt");
		setConfig(root, {
			first: stdioServer(["--tools", "1", "--spawn-counter-file", firstCounter]),
			second: stdioServer(["--tools", "1", "--spawn-counter-file", secondCounter]),
		});
		const service = getMcpService();

		await attach(service, root, "startup");
		await awaitMcpConnected(service, "first");
		await awaitMcpConnected(service, "second");
		const pids = [requiredPid(service, "first"), requiredPid(service, "second")];
		await service.handleSessionShutdown({ type: "session_shutdown", reason: "quit" });

		for (const pid of pids) {
			await assertProcessDead(pid);
		}
		expect(service.getServerSnapshots()).toEqual([]);
	});

	it("does not respawn an extension-declared server with the same config hash", async () => {
		const root = makeRoot("ext-reattach", cleanupTasks);
		const counterFile = join(root.agentDir, "ext-reattach-spawns.txt");
		const fixture = stdioFixtureCommand();
		const decl = {
			name: "fixture",
			config: {
				type: "stdio" as const,
				...fixture,
				args: [...fixture.args, "--tools", "1", "--spawn-counter-file", counterFile],
			},
			extensionPath: "<ext>",
			registrationCwd: root.cwd,
		};
		const ctx = { cwd: root.cwd, isProjectTrusted: () => true, getRegisteredMcpServers: () => [decl] };
		const service = getMcpService();

		await service.attachSession({ type: "session_start", reason: "startup" }, ctx, fakePi(), {
			agentDir: root.agentDir,
		});
		await awaitMcpConnected(service, "fixture");
		const pid1 = requiredPid(service, "fixture");
		expect(await readCounter(counterFile)).toBe(1);

		await service.handleSessionShutdown({ type: "session_shutdown", reason: "new" });
		await service.attachSession({ type: "session_start", reason: "new" }, ctx, fakePi(), {
			agentDir: root.agentDir,
		});
		const pid2 = requiredPid(service, "fixture");

		expect(pid2).toBe(pid1);
		expect(await readCounter(counterFile)).toBe(1);
	});

	it("respawns an extension-declared server on reload", async () => {
		const root = makeRoot("ext-reload", cleanupTasks);
		const counterFile = join(root.agentDir, "ext-reload-spawns.txt");
		const fixture = stdioFixtureCommand();
		const decl = {
			name: "fixture",
			config: {
				type: "stdio" as const,
				...fixture,
				args: [...fixture.args, "--tools", "1", "--spawn-counter-file", counterFile],
			},
			extensionPath: "<ext>",
			registrationCwd: root.cwd,
		};
		const ctx = { cwd: root.cwd, isProjectTrusted: () => true, getRegisteredMcpServers: () => [decl] };
		const serviceBeforeReload = getMcpService();

		await serviceBeforeReload.attachSession({ type: "session_start", reason: "startup" }, ctx, fakePi(), {
			agentDir: root.agentDir,
		});
		await awaitMcpConnected(serviceBeforeReload, "fixture");
		const pid1 = requiredPid(serviceBeforeReload, "fixture");
		await serviceBeforeReload.handleSessionShutdown({ type: "session_shutdown", reason: "reload" });
		await assertProcessDead(pid1);

		const serviceAfterReload = getMcpService();
		await serviceAfterReload.attachSession({ type: "session_start", reason: "reload" }, ctx, fakePi(), {
			agentDir: root.agentDir,
		});
		await awaitMcpConnected(serviceAfterReload, "fixture");
		const pid2 = requiredPid(serviceAfterReload, "fixture");

		expect(serviceAfterReload).not.toBe(serviceBeforeReload);
		expect(pid2).not.toBe(pid1);
		expect(await readCounter(counterFile)).toBe(2);
		await assertAlive(pid2);
	});
});

describe("registerToolsPreservingActiveSet", () => {
	it("restores the intended active tool set synchronously after auto-activating registration", () => {
		const pi = fakePi(["bash", "read"]);
		const tools = [tool("mcp_zeta"), tool("mcp_alpha"), tool("mcp_beta")];

		registerToolsPreservingActiveSet(pi, tools);

		expect(pi.registeredTools).toEqual(["mcp_alpha", "mcp_beta", "mcp_zeta"]);
		expect(pi.activeTools).toEqual(["bash", "read"]);
		expect(pi.setActiveCalls).toEqual([["bash", "read"]]);
	});

	it("accepts an explicit intended active set without letting newly registered tools leak", () => {
		const pi = fakePi(["bash", "mcp_old"]);
		const tools = [tool("mcp_new_b"), tool("mcp_new_a")];

		registerToolsPreservingActiveSet(pi, tools, ["bash"]);

		expect(pi.registeredTools).toEqual(["mcp_new_a", "mcp_new_b"]);
		expect(pi.activeTools).toEqual(["bash"]);
		expect(pi.setActiveCalls).toEqual([["bash"]]);
	});
});
