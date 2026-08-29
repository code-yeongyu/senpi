import { mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import {
	type MonitorEvent,
	MonitorRegistry,
	type MonitorSummaryEvent,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { TerminalRuntimeSession } from "../../src/core/extensions/builtin/terminal/runtime-session.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import {
	createMonitorTool,
	type MonitorInput,
	monitorSchema,
} from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

function summaryEvent(event: MonitorEvent): MonitorSummaryEvent {
	if (event.type !== "summary") throw new Error("Expected a monitor summary event");
	return event;
}

const TERMINAL_STOP_EVENT_TIMEOUT_MS = 10_000;

class EventSink {
	readonly events: MonitorEvent[] = [];
	readonly #listeners = new Set<(event: MonitorEvent) => void>();

	push(event: MonitorEvent): void {
		this.events.push(event);
		for (const listener of this.#listeners) listener(event);
	}

	waitFor(predicate: (event: MonitorEvent) => boolean, label: string, timeoutMs = 5000): Promise<MonitorEvent> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#listeners.delete(listener);
				reject(new Error(`Timed out waiting for ${label}`));
			}, timeoutMs);
			const listener = (event: MonitorEvent) => {
				if (!predicate(event)) return;
				clearTimeout(timeout);
				this.#listeners.delete(listener);
				resolve(event);
			};
			this.#listeners.add(listener);
		});
	}
}

describe("terminal monitor tool", () => {
	let manager: TerminalManager;
	let ctx: TerminalToolContext;
	let sink: EventSink;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager();
		sink = new EventSink();
		ctx = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			onMonitorEvent: (event) => sink.push(event),
		};
	});

	afterEach(async () => {
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("exposes a flat object schema so providers' legacy object conversion keeps every field", () => {
		expect(monitorSchema.type).toBe("object");
		const properties = Object.keys(monitorSchema.properties);
		for (const field of [
			"action",
			"description",
			"command",
			"path",
			"event",
			"filter",
			"timeout_ms",
			"persistent",
			"bash_id",
		]) {
			expect(properties).toContain(field);
		}
	});

	it("rejects a create call missing description and source instead of spawning", async () => {
		const tool = createMonitorTool(ctx);
		const result = await tool.execute("monitor-empty", {} as MonitorInput);
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("description");
		expect(firstText(result)).toContain("command or path");
	});

	it("rejects stale create and missing modify targets without leaving watches active", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event));
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const dir = await mkdtemp(join(tmpdir(), "senpi-monitor-file-"));
		const existing = join(dir, "existing.json");
		const missing = join(dir, "missing.json");
		await writeFile(existing, "{}");

		try {
			const createResult = await tool.execute("monitor-stale-create", {
				description: "stale creation",
				path: existing,
				event: "create",
			} as MonitorInput);
			const modifyResult = await tool.execute("monitor-missing-modify", {
				description: "missing modification",
				path: missing,
				event: "modify",
			} as MonitorInput);

			expect(createResult.isError).toBe(true);
			expect(firstText(createResult)).toContain("already exists");
			expect(modifyResult.isError).toBe(true);
			expect(firstText(modifyResult)).toContain("does not exist");
			expect(registry.snapshot()).toEqual([]);
		} finally {
			await registry.teardown();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects native watches without a lifecycle-owned registry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-monitor-file-"));
		try {
			const result = await createMonitorTool(ctx).execute("monitor-no-registry", {
				description: "missing owner",
				path: join(dir, "claim.json"),
				event: "create",
			} as MonitorInput);
			expect(result.isError).toBe(true);
			expect(firstText(result)).toContain("lifecycle-owned monitor registry");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns a tool error when the watched parent path cannot be inspected", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event));
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const dir = await mkdtemp(join(tmpdir(), "senpi-monitor-file-"));
		const parentFile = join(dir, "not-a-directory");
		await writeFile(parentFile, "");

		try {
			const result = await tool.execute("monitor-invalid-parent", {
				description: "invalid parent",
				path: join(parentFile, "doneclaim.json"),
				event: "create",
			} as MonitorInput);

			expect(result.isError).toBe(true);
			expect(firstText(result)).toContain("parent is not a directory");
			expect(registry.snapshot()).toEqual([]);
		} finally {
			await registry.teardown();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("cancels native watches individually and through kill_bash all", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event));
		const toolCtx = { ...ctx, monitorRegistry: registry };
		const monitor = createMonitorTool(toolCtx);
		const kill = createKillBashTool(toolCtx);
		const dir = await mkdtemp(join(tmpdir(), "senpi-monitor-file-"));

		try {
			const first = await monitor.execute("monitor-native-kill-one", {
				description: "kill one",
				path: join(dir, "one.json"),
				event: "create",
			} as MonitorInput);
			const firstId = /ID: (watch_\d+)/.exec(firstText(first))?.[1];
			if (!firstId) throw new Error("Expected a native watch id");
			expect(first.details).toMatchObject({ bash_id: firstId, watch_id: firstId });

			const killedOne = await kill.execute("kill-native-one", { bash_id: firstId });
			expect(firstText(killedOne)).toContain(`Killed ${firstId}`);
			expect(registry.snapshot()).toEqual([]);
			expect(
				sink.events.some(
					(event) => event.type === "summary" && event.id === firstId && event.summary.includes("killed"),
				),
			).toBe(true);

			await monitor.execute("monitor-native-kill-all-a", {
				description: "kill all a",
				path: join(dir, "all-a.json"),
				event: "create",
			} as MonitorInput);
			await monitor.execute("monitor-native-kill-all-b", {
				description: "kill all b",
				path: join(dir, "all-b.json"),
				event: "create",
			} as MonitorInput);
			const killedAll = await kill.execute("kill-native-all", { all: true });

			expect(firstText(killedAll)).toContain("Killed 2 session(s)");
			expect(registry.snapshot()).toEqual([]);
		} finally {
			await registry.teardown();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("enforces a configured native watcher capacity", async () => {
		const registryOptions = { maxSessions: 1, onChange: () => {} };
		const registry = new MonitorRegistry((event) => sink.push(event), registryOptions);
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const dir = await mkdtemp(join(tmpdir(), "senpi-monitor-file-"));

		try {
			const first = await tool.execute("monitor-capacity-first", {
				description: "capacity first",
				path: join(dir, "first.json"),
				event: "create",
			} as MonitorInput);
			const second = await tool.execute("monitor-capacity-second", {
				description: "capacity second",
				path: join(dir, "second.json"),
				event: "create",
			} as MonitorInput);

			expect(first.isError).not.toBe(true);
			expect(second.isError).toBe(true);
			expect(firstText(second)).toContain("capacity");
			expect(registry.snapshot()).toHaveLength(1);
		} finally {
			await registry.teardown();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("enforces maxSessions across command and native monitors", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event), { maxSessions: 1, onChange: () => {} });
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const dir = await mkdtemp(join(tmpdir(), "senpi-monitor-file-"));

		try {
			const native = await tool.execute("monitor-shared-capacity-file", {
				description: "shared capacity file",
				path: join(dir, "claim.json"),
				event: "create",
			} as MonitorInput);
			const command = await tool.execute("monitor-shared-capacity-command", {
				description: "shared capacity command",
				command: "printf 'SHOULD_NOT_START\\n'",
			});

			expect(native.isError).not.toBe(true);
			expect(command.isError).toBe(true);
			expect(firstText(command)).toContain("capacity");
			expect(manager.size).toBe(0);
			expect(registry.snapshot()).toHaveLength(1);
		} finally {
			await registry.teardown();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("counts ordinary terminal sessions against native watcher capacity", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event), {
			maxSessions: 1,
			onChange: () => {},
			getTerminalSessionCount: () => 1,
		});
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const dir = await mkdtemp(join(tmpdir(), "senpi-monitor-file-"));

		try {
			const result = await tool.execute("monitor-terminal-capacity", {
				description: "terminal capacity",
				path: join(dir, "claim.json"),
				event: "create",
			} as MonitorInput);

			expect(result.isError).toBe(true);
			expect(firstText(result)).toContain("capacity");
			expect(registry.snapshot()).toEqual([]);
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rolls back command monitor state when publication throws", async () => {
		let publications = 0;
		const registry = new MonitorRegistry((event) => sink.push(event), {
			onChange: () => {
				publications += 1;
				if (publications === 1) throw new Error("state publication failure");
			},
		});
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });

		try {
			await expect(
				tool.execute("monitor-publication-failure", {
					description: "publication failure",
					command: "sleep 30",
				}),
			).rejects.toThrow("state publication failure");
			expect(registry.snapshot()).toEqual([]);
			expect(publications).toBe(2);
		} finally {
			registry.dispose();
		}
	});

	it("rejects rearm without bash_id", async () => {
		const tool = createMonitorTool(ctx);
		const result = await tool.execute("monitor-rearm-missing", { action: "rearm" } as MonitorInput);
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("bash_id");
	});

	it("rejects create-only fields on rearm", async () => {
		const tool = createMonitorTool(ctx);
		const result = await tool.execute("monitor-rearm-path", {
			action: "rearm",
			bash_id: "bash_1",
			path: "package.json",
		});
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("path");
	});

	it("returns a bash_id immediately and emits complete stdout lines in order before its summary", async () => {
		const tool = createMonitorTool(ctx);
		const summary = sink.waitFor((event) => event.type === "summary", "monitor completion");

		const result = await tool.execute("monitor-create", {
			description: "line order",
			command: "printf 'ONE\\nTWO\\n'",
		});

		const bashId = /ID: (bash_\d+)/.exec(firstText(result))?.[1];
		expect(bashId).toBeDefined();
		if (!bashId) throw new Error("Expected monitor to return a bash id");
		expect(manager.get(bashId)).not.toBeNull();
		await summary;
		expect(sink.events.map((event) => (event.type === "line" ? event.line : event.summary))).toEqual([
			"ONE",
			"TWO",
			expect.stringContaining("completed"),
		]);
	});

	it("filters monitor events without removing non-matching terminal output from peek history", async () => {
		const tool = createMonitorTool(ctx);
		const summary = sink.waitFor((event) => event.type === "summary", "filtered completion");
		const result = await tool.execute("monitor-filter", {
			description: "filtered",
			command: "printf 'KEEP_ONE\\nDROP\\nKEEP_TWO\\n'",
			filter: "^KEEP",
		});
		const bashId = /ID: (bash_\d+)/.exec(firstText(result))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		await summary;
		expect(sink.events.filter((event) => event.type === "line").map((event) => event.line)).toEqual([
			"KEEP_ONE",
			"KEEP_TWO",
		]);
		expect(manager.get(bashId)?.fullOutput()).toContain("DROP");
	});

	it("ends a timed watch and leaves persistent watches alive past their timeout", async () => {
		const tool = createMonitorTool(ctx);
		const timedOut = sink.waitFor(
			(event) => event.type === "summary" && event.description === "timed",
			"timeout summary",
			TERMINAL_STOP_EVENT_TIMEOUT_MS,
		);
		const timedResult = await tool.execute("monitor-timeout", {
			description: "timed",
			command: "sleep 30",
			timeout_ms: 50,
		});
		expect(firstText(timedResult)).toMatch(/ID: bash_\d+/);
		expect(summaryEvent(await timedOut).summary).toContain("timed_out");

		const persistent = sink.waitFor(
			(event) => event.type === "summary" && event.description === "persistent",
			"persistent completion",
		);
		await tool.execute("monitor-persistent", {
			description: "persistent",
			command: "sleep 0.05; printf 'PERSISTED\\n'",
			timeout_ms: 10,
			persistent: true,
		});
		expect(summaryEvent(await persistent).summary).toContain("completed");
	});

	it("shares the bash registry with kill_bash and treats rearm of a live monitor as a no-op", async () => {
		const tool = createMonitorTool(ctx);
		const ended = sink.waitFor(
			(event) => event.type === "summary",
			"killed monitor summary",
			TERMINAL_STOP_EVENT_TIMEOUT_MS,
		);
		const started = await tool.execute("monitor-live", { description: "live", command: "sleep 30" });
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		const rearm = await tool.execute("monitor-rearm", { action: "rearm", bash_id: bashId });
		expect(firstText(rearm)).toContain("not paused");
		const killed = await createKillBashTool(ctx).execute("kill-monitor", { bash_id: bashId });
		expect(firstText(killed)).toContain(`Killed ${bashId}`);
		expect(summaryEvent(await ended).summary).toContain("killed");
	});

	it("settles a killed monitor when manager stop returns before process exit", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event));
		const runtime = {
			exited: false,
			exitResult: null,
			fullOutput: () => "",
			onOutput: () => () => {},
			session: { onExit: () => () => {} },
		} as unknown as TerminalRuntimeSession;
		registry.register({
			id: "bash_1",
			description: "late close",
			runtime,
		});
		const slowManager = {
			get: (id: string) => (id === "bash_1" ? runtime : null),
			stop: async () => true,
		} as unknown as TerminalManager;
		const killed = await createKillBashTool({ ...ctx, manager: slowManager, monitorRegistry: registry }).execute(
			"kill-late-close",
			{ bash_id: "bash_1" },
		);

		expect(firstText(killed)).toContain("Killed bash_1");
		expect(registry.snapshot()).toEqual([]);
		expect(sink.events).toContainEqual(
			expect.objectContaining({
				type: "summary",
				id: "bash_1",
				summary: "watcher killed",
			}),
		);
	});

	it("keeps the terminal manager reusable after kill-all", async () => {
		const killed = await createKillBashTool(ctx).execute("kill-all-empty", { all: true });
		expect(firstText(killed)).toContain("Killed 0 terminal session(s)");

		const created = await manager.create(process.execPath, {
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
			cwd: process.cwd(),
			env: { ...process.env, SENPI_PTY_FORCE_PIPE: "1" },
			cols: 80,
			rows: 24,
		});
		await created.runtime.session.waitExit();
		expect(created.runtime.exitResult?.exitCode).toBe(0);
	});

	it("emits a final summary when a wake-budget-paused monitor exits", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event));
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const ended = sink.waitFor(
			(event) => event.type === "summary",
			"paused monitor completion",
			TERMINAL_STOP_EVENT_TIMEOUT_MS,
		);
		const started = await tool.execute("monitor-paused-exit", { description: "paused exit", command: "sleep 30" });
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		registry.pauseAll();
		await createKillBashTool(ctx).execute("kill-paused", { bash_id: bashId });
		expect(summaryEvent(await ended).summary).toContain("killed");
	});

	it("rearms a wake-budget-paused monitor and notifies the session delivery controller", async () => {
		let rearmedId: string | undefined;
		const registry = new MonitorRegistry((event) => sink.push(event));
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry, onMonitorRearmed: (id) => (rearmedId = id) });
		const ended = sink.waitFor((event) => event.type === "summary", "rearmed monitor completion");
		const started = await tool.execute("monitor-paused", { description: "paused", command: "sleep 30" });
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		expect(registry.pauseAll()).toEqual([bashId]);
		const rearmed = await tool.execute("monitor-resume", { action: "rearm", bash_id: bashId });
		expect(firstText(rearmed)).toContain("re-armed");
		expect(rearmedId).toBe(bashId);
		await createKillBashTool(ctx).execute("kill-rearmed", { bash_id: bashId });
		expect(summaryEvent(await ended).summary).toContain("killed");
	});

	it("resolves the session-scoped monitor registry when execution begins", async () => {
		let registry = new MonitorRegistry(() => {});
		const liveSink = new EventSink();
		const tool = createMonitorTool({
			...ctx,
			get monitorRegistry() {
				return registry;
			},
		});
		registry = new MonitorRegistry((event) => liveSink.push(event));
		const summary = liveSink.waitFor((event) => event.type === "summary", "session-scoped completion");

		await tool.execute("monitor-session-registry", {
			description: "session registry",
			command: "printf 'CURRENT\\n'",
		});

		expect(summaryEvent(await summary).summary).toContain("completed");
	});

	it("uses the same bash permission class as command execution", () => {
		const requests = createBuiltinParserRegistry().parse("monitor", { command: "rm -rf /tmp/monitor" }, "/tmp");
		expect(requests[0]?.permission).toBe("bash");
		expect(requests[0]?.patterns).toContain("rm");
	});

	it("uses read permission for a native file watch", () => {
		const requests = createBuiltinParserRegistry().parse("monitor", { path: "/tmp/doneclaim.json" }, "/tmp");
		expect(requests[0]?.permission).toBe("read");
		expect(requests[0]?.patterns).toContain("/tmp/doneclaim.json");
	});

	it("requires external-directory permission for a symlinked external parent", async () => {
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-workspace-")));
		const external = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-external-")));
		await symlink(external, join(workspace, "link"));
		const logicalPath = join(workspace, "link", "doneclaim.json");

		try {
			const requests = createBuiltinParserRegistry().parse("monitor", { path: logicalPath }, workspace);
			const readRequest = requests.find((request) => request.permission === "read");
			expect(readRequest?.patterns).toEqual([logicalPath, join(external, "doneclaim.json")]);
			expect(requests.some((request) => request.permission === "external_directory")).toBe(true);
		} finally {
			await rm(workspace, { recursive: true, force: true });
			await rm(external, { recursive: true, force: true });
		}
	});

	it("rejects a logical parent retargeted after permission parsing", async () => {
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-workspace-")));
		const externalA = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-external-a-")));
		const externalB = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-external-b-")));
		const link = join(workspace, "link");
		const logicalPath = join(link, "doneclaim.json");
		await symlink(externalA, link);
		const input = {
			description: "bound canonical parent",
			path: logicalPath,
			event: "create",
		} as MonitorInput;
		createBuiltinParserRegistry().parse("monitor", input, workspace);
		await rm(link);
		await symlink(externalB, link);
		await writeFile(join(externalA, "doneclaim.json"), "{}");
		const registry = new MonitorRegistry((event) => sink.push(event));

		try {
			const result = await createMonitorTool({ ...ctx, monitorRegistry: registry }).execute(
				"monitor-bound-parent",
				input,
			);
			expect(result.isError).toBe(true);
			expect(firstText(result)).toContain("approved monitor parent changed");
			expect(registry.snapshot()).toEqual([]);
		} finally {
			registry.dispose();
			await rm(workspace, { recursive: true, force: true });
			await rm(externalA, { recursive: true, force: true });
			await rm(externalB, { recursive: true, force: true });
		}
	});

	it("rejects an approved canonical parent whose filesystem identity changed", async () => {
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-workspace-")));
		const approvedParent = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-approved-")));
		const movedApprovedParent = `${approvedParent}-moved`;
		const replacementParent = await realpath(await mkdtemp(join(tmpdir(), "senpi-monitor-replacement-")));
		const link = join(workspace, "link");
		await symlink(approvedParent, link);
		const input = {
			description: "bound parent identity",
			path: join(link, "doneclaim.json"),
			event: "create",
		} as MonitorInput;
		createBuiltinParserRegistry().parse("monitor", input, workspace);
		await rename(approvedParent, movedApprovedParent);
		await symlink(replacementParent, approvedParent);
		const registry = new MonitorRegistry((event) => sink.push(event));

		try {
			const result = await createMonitorTool({ ...ctx, monitorRegistry: registry }).execute(
				"monitor-bound-parent-identity",
				input,
			);
			expect(result.isError).toBe(true);
			expect(firstText(result)).toContain("approved monitor parent changed");
			expect(registry.snapshot()).toEqual([]);
		} finally {
			registry.dispose();
			await rm(workspace, { recursive: true, force: true });
			await rm(approvedParent, { recursive: true, force: true });
			await rm(movedApprovedParent, { recursive: true, force: true });
			await rm(replacementParent, { recursive: true, force: true });
		}
	});
});
