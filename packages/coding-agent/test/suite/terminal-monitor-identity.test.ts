import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import {
	allocateMonitorId,
	type MonitorEvent,
	MonitorRegistry,
	type MonitorSummaryEvent,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { createBashOutputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import { createMonitorTool, type MonitorInput } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";

const MONITOR_ID_GRAMMAR = /^mon_[0-9A-HJKMNP-TV-Z]{16}$/;

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

function summaryEvent(event: MonitorEvent): MonitorSummaryEvent {
	if (event.type !== "summary") throw new Error("Expected a monitor summary event");
	return event;
}

class EventSink {
	readonly events: MonitorEvent[] = [];
	readonly #listeners = new Set<(event: MonitorEvent) => void>();

	push(event: MonitorEvent): void {
		this.events.push(event);
		for (const listener of this.#listeners) listener(event);
	}

	waitFor(predicate: (event: MonitorEvent) => boolean, label: string): Promise<MonitorEvent> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#listeners.delete(listener);
				reject(new Error(`Timed out waiting for ${label}`));
			}, 5000);
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

describe("terminal monitor restore-context environment", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	let manager: TerminalManager;
	let registry: MonitorRegistry;
	let sink: EventSink;
	let sessionDir: string;
	let ctx: TerminalToolContext;

	beforeEach(async () => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		sessionDir = await mkdtemp(join(tmpdir(), "senpi-monitor-env-"));
		manager = new TerminalManager();
		sink = new EventSink();
		registry = new MonitorRegistry((event) => sink.push(event));
		ctx = {
			manager,
			cwd: sessionDir,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
			onMonitorEvent: (event) => sink.push(event),
			getSessionContext: () =>
				({
					mode: "tui",
					sessionManager: { getSessionId: () => "env-session", getSessionDir: () => sessionDir },
				}) as unknown as ExtensionContext,
		};
	});

	afterEach(async () => {
		registry.dispose();
		await manager.teardown();
		await rm(sessionDir, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	/** The watch's first `|`-separated line: already delivered during the create, or the next one to arrive. */
	function envLine(): Promise<string> {
		const isEnvLine = (event: MonitorEvent) => event.type === "line" && event.line.includes("|");
		const delivered = sink.events.find(isEnvLine);
		const next = delivered ? Promise.resolve(delivered) : sink.waitFor(isEnvLine, "env echo line");
		return next.then((event) => (event.type === "line" ? event.line : ""));
	}

	it("hands a persistent command watch its stable id and a per-monitor state dir that exists", async () => {
		const created = await createMonitorTool(ctx).execute("env", {
			description: "env watch",
			command:
				'r="$SENPI_MONITOR_RESTORED"; printf "%s|%s|%s\\n" "$SENPI_MONITOR_ID" "$SENPI_MONITOR_STATE_DIR" "$r"; sleep 30',
			persistent: true,
		});
		const monitorId = String(created.details?.monitor_id);
		const [id, dir, restored] = (await envLine()).trim().split("|");
		expect(id).toBe(monitorId);
		expect(dir).toBe(join(sessionDir, "extensions", "terminal", "state", monitorId));
		expect(restored).toBe("");
		expect(existsSync(join(sessionDir, "extensions", "terminal", "state", monitorId))).toBe(true);
	});

	it("gives an ephemeral watch its id but no state dir", async () => {
		const created = await createMonitorTool(ctx).execute("env", {
			description: "ephemeral env watch",
			command:
				'd="$SENPI_MONITOR_STATE_DIR"; [ -n "$d" ] || d=none; printf "%s|%s\\n" "$SENPI_MONITOR_ID" "$d"; sleep 30',
			timeout_ms: 60_000,
		});
		const [id, dir] = (await envLine()).trim().split("|");
		expect(id).toBe(String(created.details?.monitor_id));
		expect(dir).toBe("none");
		expect(existsSync(join(sessionDir, "extensions", "terminal", "state"))).toBe(false);
	});
});

describe("terminal monitor identity", () => {
	let manager: TerminalManager;
	let registry: MonitorRegistry;
	let ctx: TerminalToolContext;
	let sink: EventSink;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(() => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager();
		sink = new EventSink();
		registry = new MonitorRegistry((event) => sink.push(event));
		ctx = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
			monitorRegistry: registry,
			onMonitorEvent: (event) => sink.push(event),
		};
	});

	afterEach(async () => {
		registry.dispose();
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
	});

	it("(a) reports the stable monitor id in the result text and the runtime bash id in details", async () => {
		const result = await createMonitorTool(ctx).execute("identity-create", {
			description: "identity shape",
			command: "sleep 30",
			persistent: true,
		} satisfies MonitorInput);

		expect(result.isError).not.toBe(true);
		expect(firstText(result)).toMatch(/^Monitor started with ID: mon_[0-9A-HJKMNP-TV-Z]{16}$/);
		const monitorId = /^Monitor started with ID: (mon_\S+)$/.exec(firstText(result))?.[1];
		const details = (result.details ?? {}) as Record<string, unknown>;
		expect(String(details.bash_id)).toMatch(/^bash_\d+$/);
		expect(details.monitor).toBe(true);
		expect(details.monitor_id).toBe(monitorId);
	});

	it("(b) kill_bash accepts the monitor id, stops the PTY, and settles the monitor as killed", async () => {
		const tool = createMonitorTool(ctx);
		const started = await tool.execute("identity-kill-create", {
			description: "kill via monitor id",
			command: "sleep 30",
			persistent: true,
		} satisfies MonitorInput);
		const monitorId = /ID: (mon_\S+)$/.exec(firstText(started))?.[1];
		const bashId = String(((started.details ?? {}) as Record<string, unknown>).bash_id);
		if (!monitorId || !/^bash_\d+$/.test(bashId)) throw new Error("Monitor did not return ids");

		const settled = sink.waitFor(
			(event) => event.type === "summary" && event.id === bashId,
			"killed monitor summary",
		);
		const killed = await createKillBashTool(ctx).execute("identity-kill", { bash_id: monitorId });

		expect(firstText(killed)).toContain(`Killed ${monitorId}`);
		expect(summaryEvent(await settled).summary).toContain("killed");
		expect(registry.snapshot().some((entry) => entry.id === bashId)).toBe(false);
		expect(registry.snapshot().some((entry) => entry.monitorId === monitorId)).toBe(false);
	});

	it("(c) bash_output via the monitor id returns the same output as via the runtime bash id", async () => {
		const tool = createMonitorTool(ctx);
		const outputTool = createBashOutputTool(ctx);
		const firstLine = sink.waitFor(
			(event) => event.type === "line" && event.line === "IDENTITY_MARK",
			"first monitor mark",
		);
		const secondLine = sink.waitFor(
			(event) =>
				event.type === "line" &&
				event.line === "IDENTITY_MARK" &&
				sink.events.filter((e) => e.type === "line").length >= 2,
			"second monitor mark",
		);
		const first = await tool.execute("identity-output-a", {
			description: "shared output a",
			command: "printf 'IDENTITY_MARK\\n'; sleep 30",
			persistent: true,
		} satisfies MonitorInput);
		const second = await tool.execute("identity-output-b", {
			description: "shared output b",
			command: "printf 'IDENTITY_MARK\\n'; sleep 30",
			persistent: true,
		} satisfies MonitorInput);
		const monitorId = /ID: (mon_\S+)$/.exec(firstText(first))?.[1];
		const bashId = String(((first.details ?? {}) as Record<string, unknown>).bash_id);
		if (!monitorId || !/^bash_\d+$/.test(bashId)) throw new Error("Monitor did not return ids");
		const otherBashId = String(((second.details ?? {}) as Record<string, unknown>).bash_id);
		await Promise.all([firstLine, secondLine]);

		const viaMonitorId = await outputTool.execute("identity-output-mon", { bash_id: monitorId });
		const viaBashId = await outputTool.execute("identity-output-bash", { bash_id: otherBashId });

		expect(firstText(viaMonitorId)).toBe(firstText(viaBashId));
		expect(firstText(viaMonitorId)).toContain("IDENTITY_MARK");
		expect(viaMonitorId.details).toEqual(viaBashId.details);
	});

	it("(d) monitor rearm accepts the monitor id of a paused monitor", async () => {
		const tool = createMonitorTool(ctx);
		const started = await tool.execute("identity-rearm-create", {
			description: "rearm via monitor id",
			command: "sleep 30",
			persistent: true,
		} satisfies MonitorInput);
		const monitorId = /ID: (mon_\S+)$/.exec(firstText(started))?.[1];
		const bashId = String(((started.details ?? {}) as Record<string, unknown>).bash_id);
		if (!monitorId || !/^bash_\d+$/.test(bashId)) throw new Error("Monitor did not return ids");

		expect(registry.pause([bashId])).toEqual([bashId]);
		expect(registry.snapshot().find((entry) => entry.id === bashId)?.paused).toBe(true);

		const rearmed = await tool.execute("identity-rearm", {
			action: "rearm",
			bash_id: monitorId,
		} satisfies MonitorInput);

		expect(rearmed.isError).not.toBe(true);
		expect(firstText(rearmed)).toContain("re-armed");
		expect(registry.snapshot().find((entry) => entry.id === bashId)?.paused).toBe(false);
	});

	it("(e) an unknown monitor id yields exactly the missing-session error", async () => {
		const outputTool = createBashOutputTool(ctx);
		const result = await outputTool.execute("identity-unknown", { bash_id: "mon_0000000000000000" });

		expect(result.isError).toBe(true);
		expect(firstText(result)).toBe("No terminal session found with id: mon_0000000000000000");
	});

	it("(f) allocates 1000 distinct monitor ids that all match the grammar", () => {
		const ids = Array.from({ length: 1000 }, () => allocateMonitorId());

		expect(new Set(ids).size).toBe(1000);
		for (const id of ids) expect(id).toMatch(MONITOR_ID_GRAMMAR);
	});

	it("re-binds a caller-supplied monitorId so a later restore keeps the same identity", async () => {
		const started = await createMonitorTool(ctx).execute("identity-restore-create", {
			description: "restore target",
			command: "sleep 30",
			persistent: true,
		} satisfies MonitorInput);
		const bashId = String(((started.details ?? {}) as Record<string, unknown>).bash_id);
		const runtime = manager.get(bashId);
		if (!runtime) throw new Error("Monitor runtime missing");

		const restored = new MonitorRegistry(() => {});
		const monitorId = "mon_0123456789ABCDEFG";
		const rebound = restored.register({ id: bashId, monitorId, description: "restored", runtime });
		ctx.manager.bindMonitorId(rebound, bashId);

		expect(rebound).toBe(monitorId);
		expect(restored.snapshot()[0]?.monitorId).toBe(monitorId);
		expect(restored.snapshot()[0]?.id).toBe(bashId);
		expect(manager.resolveId(monitorId)).toBe(bashId);
	});
});
