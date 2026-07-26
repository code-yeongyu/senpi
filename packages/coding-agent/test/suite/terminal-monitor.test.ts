import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import {
	type MonitorEvent,
	MonitorRegistry,
	type MonitorSummaryEvent,
} from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import { createMonitorTool } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

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

	it("returns a bash_id immediately and emits complete stdout lines in order before its summary", async () => {
		const tool = createMonitorTool(ctx);
		const summary = sink.waitFor((event) => event.type === "summary", "monitor completion");

		const result = await tool.execute("monitor-create", {
			description: "line order",
			command: "printf 'ONE\\nTWO\\n'",
		});

		const bashId = /ID: (bash_\d+)/.exec(firstText(result))?.[1];
		expect(bashId).toBeDefined();
		expect(manager.get(bashId!)).not.toBeNull();
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
		const ended = sink.waitFor((event) => event.type === "summary", "killed monitor summary");
		const started = await tool.execute("monitor-live", { description: "live", command: "sleep 30" });
		const bashId = /ID: (bash_\d+)/.exec(firstText(started))?.[1];
		if (!bashId) throw new Error("Monitor did not return a bash_id");

		const rearm = await tool.execute("monitor-rearm", { action: "rearm", bash_id: bashId });
		expect(firstText(rearm)).toContain("not paused");
		const killed = await createKillBashTool(ctx).execute("kill-monitor", { bash_id: bashId });
		expect(firstText(killed)).toContain(`Killed ${bashId}`);
		expect(summaryEvent(await ended).summary).toContain("killed");
	});

	it("emits a final summary when a wake-budget-paused monitor exits", async () => {
		const registry = new MonitorRegistry((event) => sink.push(event));
		const tool = createMonitorTool({ ...ctx, monitorRegistry: registry });
		const ended = sink.waitFor((event) => event.type === "summary", "paused monitor completion");
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
});
