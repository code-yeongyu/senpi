// Brain/hand split plan row S16a (Z2.ISO.a): one runtime serving several execution scopes keeps each scope's terminal
// sessions, monitors and background sessions in that scope's own bundle, so releasing a scope stops exactly its PTYs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildScopeToolContext,
	createScopedBundles,
} from "../../src/core/extensions/builtin/terminal/extension-state.ts";
import type {
	ScopedTerminalBundles,
	TerminalEventSinks,
} from "../../src/core/extensions/builtin/terminal/session-bundle.ts";
import { TERMINAL_SETTINGS_DEFAULTS } from "../../src/core/extensions/builtin/terminal/settings.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import { createBashInputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-input.ts";
import { createBashOutputTool } from "../../src/core/extensions/builtin/terminal/tools/bash-output.ts";
import type {
	TerminalToolContext,
	TerminalToolResult,
} from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";
import { createMonitorTool } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

type ToolState = Parameters<typeof buildScopeToolContext>[0] & Parameters<typeof createScopedBundles>[0];

interface SeenEvents {
	readonly background: string[][];
	readonly monitors: string[][];
}

const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
const seen = new Map<string, SeenEvents>();
let root: string;
let scopes: ScopedTerminalBundles | undefined;

beforeEach(async () => {
	process.env.SENPI_PTY_FORCE_PIPE = "1";
	root = await mkdtemp(join(tmpdir(), "senpi-scope-terminal-"));
});

afterEach(async () => {
	await scopes?.dispose();
	scopes = undefined;
	seen.clear();
	await rm(root, { recursive: true, force: true });
	if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
	else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
});

// Each scope's sinks record what that scope's bundle published, so a leak shows up as a foreign id.
function recordingSinks(scopeId: string): TerminalEventSinks {
	const events: SeenEvents = { background: [], monitors: [] };
	seen.set(scopeId, events);
	return {
		onMonitorEvent: () => {},
		onMonitorEnded: () => {},
		onMonitorState: (snapshot) => events.monitors.push(snapshot.map((entry) => entry.id)),
		onBackgroundState: (snapshot) => events.background.push(snapshot.map((entry) => entry.id)),
		onBackgroundExit: () => {},
	};
}

function runtimeWithScopes(maxSessions = TERMINAL_SETTINGS_DEFAULTS.maxSessions) {
	const state: ToolState = {
		settings: { ...TERMINAL_SETTINGS_DEFAULTS, maxSessions },
		parked: false,
		ctx: undefined,
		shellPath: undefined,
		monitorNotifier: null,
		ensurePersistence: null,
	};
	const owner = createScopedBundles(state, recordingSinks);
	scopes = owner;
	const scope = (id: string) => {
		const ctx = buildScopeToolContext(state, owner, { id, root });
		return {
			ctx,
			bash: createPtyBashTool(ctx),
			output: createBashOutputTool(ctx),
			input: createBashInputTool(ctx),
			kill: createKillBashTool(ctx),
			monitor: createMonitorTool(ctx),
		};
	};
	return { owner, scope };
}

type Scope = ReturnType<ReturnType<typeof runtimeWithScopes>["scope"]>;

function firstText(result: TerminalToolResult): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

async function start(scope: Scope, command: string): Promise<string> {
	const started = await scope.bash.execute("call-start", { command, run_in_background: true }, undefined);
	const id = /ID: (bash_\w+)/.exec(firstText(started))?.[1];
	if (id === undefined) throw new Error(`no bash id in: ${firstText(started)}`);
	return id;
}

// Event-driven wait: subscribe first, then check what is already buffered.
function outputArrives(ctx: TerminalToolContext, id: string, text: string): Promise<void> {
	const runtime = ctx.manager.get(id);
	if (!runtime) throw new Error(`no session ${id}`);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${text} never arrived on ${id}`)), 5000);
		const done = (): void => {
			clearTimeout(timer);
			unsubscribe();
			resolve();
		};
		const unsubscribe = runtime.onOutput((chunk) => {
			if (chunk.includes(text)) done();
		});
		if (runtime.fullOutput().includes(text)) done();
	});
}

const ids = (ctx: TerminalToolContext): string[] => ctx.manager.list().map((entry) => entry.id);

describe("terminal state is scoped per execution scope (S16a)", () => {
	it("MULTI: a scope lists, reads, writes and kills only its own terminal sessions", async () => {
		// Given scopes A and B on one runtime, each with a live background session.
		const { scope } = runtimeWithScopes();
		const a = scope("A");
		const b = scope("B");
		const aId = await start(a, "cat");
		const bId = await start(b, "cat");

		// Then each scope lists only its own session, and the ids never collide.
		expect(aId).not.toBe(bId);
		expect(ids(a.ctx)).toEqual([aId]);
		expect(ids(b.ctx)).toEqual([bId]);

		// When B reads, writes to and kills A's session by id, every call is refused.
		expect((await b.output.execute("b-read", { bash_id: aId })).isError).toBe(true);
		expect((await b.input.execute("b-write", { bash_id: aId, input: "from-B" })).isError).toBe(true);
		expect((await b.kill.execute("b-kill", { bash_id: aId })).isError).toBe(true);

		// When B kills all of its sessions.
		await b.kill.execute("b-kill-all", { all: true });

		// Then A's session still runs and answers A's own input.
		expect(a.ctx.manager.get(aId)?.exited).toBe(false);
		const echoed = outputArrives(a.ctx, aId, "from-A");
		expect((await a.input.execute("a-write", { bash_id: aId, input: "from-A" })).isError).toBeFalsy();
		await echoed;
		expect(firstText(await a.output.execute("a-read", { bash_id: aId }))).toContain("from-A");
		expect(firstText(await a.output.execute("a-read-again", { bash_id: aId }))).not.toContain("from-B");

		// And each scope's background-state events name only its own session.
		expect(seen.get("A")?.background.flat()).toContain(aId);
		expect(seen.get("A")?.background.flat()).not.toContain(bId);
		expect(seen.get("B")?.background.flat()).not.toContain(aId);
	});

	it("MULTI: monitors stay in their scope, and releasing a scope stops exactly its PTYs and monitors", async () => {
		// Given A with a background session and a command monitor, and B with a background session.
		const { owner, scope } = runtimeWithScopes();
		const a = scope("A");
		const b = scope("B");
		const aId = await start(a, "cat");
		const bId = await start(b, "cat");
		const watched = await a.monitor.execute("a-monitor", { description: "A watch", command: "cat" });
		expect(watched.isError).toBeFalsy();

		// Then only A sees the monitor, in its registry and in its monitor-state events.
		expect(a.ctx.monitorRegistry?.snapshot()).toHaveLength(1);
		expect(b.ctx.monitorRegistry?.snapshot()).toHaveLength(0);
		expect(seen.get("A")?.monitors.at(-1)).toHaveLength(1);
		expect(seen.get("B")?.monitors.flat()).toEqual([]);
		const aRuntimes = a.ctx.manager.list().map((entry) => entry.runtime);
		expect(aRuntimes).toHaveLength(2);

		// When scope A is released.
		await owner.releaseScope("A");

		// Then A's session and monitor are stopped and its bundle is gone.
		for (const runtime of aRuntimes) expect(runtime.exited).toBe(true);
		expect(owner.peek("A")).toBeUndefined();

		// And B's session keeps running and answering.
		expect(b.ctx.manager.get(bId)?.exited).toBe(false);
		const echoed = outputArrives(b.ctx, bId, "still-B");
		await b.input.execute("b-write", { bash_id: bId, input: "still-B" });
		await echoed;

		// And a released scope that comes back starts from an empty bundle.
		expect(ids(a.ctx)).toEqual([]);
		expect(a.ctx.manager.get(aId)).toBeNull();
	});

	it("applies maxSessions per scope and starts nothing for a scope that never uses the terminal", async () => {
		// Given a runtime whose terminal admits one session, and three scopes.
		const { owner, scope } = runtimeWithScopes(1);
		const a = scope("A");
		const b = scope("B");
		scope("C");

		// When A fills its limit, its next session is refused, while B still gets its own.
		await start(a, "cat");
		await expect(a.bash.execute("a-second", { command: "cat", run_in_background: true }, undefined)).rejects.toThrow(
			/all 1 registry slots are live/,
		);
		const bId = await start(b, "cat");
		expect(ids(b.ctx)).toEqual([bId]);

		// Then C, which built a tool context but ran no tool, has no bundle and published nothing.
		expect(owner.peek("C")).toBeUndefined();
		expect(seen.has("C")).toBe(false);
		await owner.releaseScope("C");

		// And a disposed owner gives no scope a new bundle.
		await owner.dispose();
		expect(() => owner.forScope("D")).toThrow();
	});
});
