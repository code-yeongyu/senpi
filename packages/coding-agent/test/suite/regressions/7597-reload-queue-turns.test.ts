// Turns in the process-wide config-reload queue (#7597) for sessions that are not simply idle when their turn comes.
// A real reload replaces the extension instance, so these drive instances directly as the config-reload owner tests do.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEventBus } from "../../../src/core/event-bus.ts";
import configReloadExtension from "../../../src/core/extensions/builtin/config-reload/index.ts";
import type { ConfigReloadLogger } from "../../../src/core/extensions/builtin/config-reload/log.ts";
import { RELOAD_SLOT_TIMEOUT_MS } from "../../../src/core/extensions/builtin/config-reload/reload-queue.ts";
import type { WatchEventListener } from "../../../src/core/extensions/builtin/config-reload/watch-engine.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";

const roots: string[] = [];
// Every reload a test leaves open; afterEach settles them so the process-wide queue is empty for the next test.
const openReloads: Array<PromiseWithResolvers<void>> = [];

async function settleOpenReloads(): Promise<void> {
	for (let index = 0; index < openReloads.length; index++) {
		openReloads[index]?.resolve();
		await vi.advanceTimersByTimeAsync(0);
	}
	openReloads.length = 0;
}

afterEach(async () => {
	if (vi.isFakeTimers()) await settleOpenReloads();
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Config-reload instances watching one settings file. A context named in `busy` is not idle, and each context's
 * reload stays open until the test settles it; `reached(name)` resolves when it starts and `<name> done` when it ends.
 */
function reloadRig() {
	vi.useFakeTimers();
	const root = mkdtempSync(join(tmpdir(), "reload-turns-"));
	roots.push(root);
	const settings = join(root, "settings.json");
	writeFileSync(settings, JSON.stringify({ theme: "dark" }));
	const bus = createEventBus();
	const listeners = new Set<WatchEventListener>();
	const warnings: string[] = [];
	const status = { written: false, disabled: true };
	const logger: ConfigReloadLogger = {
		debug: () => status,
		info: () => status,
		warn: (event) => {
			warnings.push(event);
			return status;
		},
		error: () => status,
	};
	const options = {
		agentDir: root,
		clock: { setTimeout, clearTimeout },
		logger,
		subscribe: (path: string, listener: WatchEventListener) => {
			if (path === root) listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const calls: string[] = [];
	const busy = new Set<string>();
	const edges = new Map<string, PromiseWithResolvers<void>>();
	const edge = (name: string) => {
		const known = edges.get(name) ?? Promise.withResolvers<void>();
		edges.set(name, known);
		return known;
	};
	let active = 0;
	let peak = 0;
	return {
		calls,
		busy,
		warnings,
		peak: () => peak,
		reached: (name: string) => edge(name).promise,
		instance() {
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
			configReloadExtension({ events: bus, on: handlers.set.bind(handlers) } as unknown as ExtensionAPI, options);
			return (event: { readonly type: string; readonly reason?: string }, ctx: ExtensionContext) =>
				handlers.get(event.type)?.(event, ctx);
		},
		context: (name: string, duringReload?: () => Promise<void>) =>
			({
				cwd: root,
				mode: "tui",
				ui: { notify: () => {} },
				isIdle: () => !busy.has(name),
				hasPendingMessages: () => false,
				isProjectTrusted: () => true,
				isCompacting: () => false,
				requestReload: async () => {
					const open = Promise.withResolvers<void>();
					openReloads.push(open);
					calls.push(name);
					peak = Math.max(peak, ++active);
					edge(name).resolve();
					await duringReload?.();
					await open.promise;
					active--;
					edge(`${name} done`).resolve();
				},
			}) as unknown as ExtensionContext,
		writeSettings: (theme: string) => writeFileSync(settings, JSON.stringify({ theme })),
		async change(theme: string) {
			writeFileSync(settings, JSON.stringify({ theme }));
			for (const listener of listeners) listener("change", "settings.json");
			await vi.advanceTimersByTimeAsync(200);
		},
	};
}

// #7599 review: a reload the reloaded session requests from its own session_start waits its turn instead of
// waiting on the reload that is running it.
it("queues a follow-up requested during a session's reload behind the other sessions", async () => {
	const rig = reloadRig();
	const a = rig.instance();
	const aContext = rig.context("a", async () => {
		await a({ type: "session_shutdown", reason: "reload" }, aContext);
		rig.writeSettings("changed during the reload");
		await rig.instance()({ type: "session_start", reason: "reload" }, rig.context("a follow-up"));
	});
	await a({ type: "session_start", reason: "startup" }, aContext);
	await rig.instance()({ type: "session_start", reason: "startup" }, rig.context("b"));
	await rig.change("light");
	expect(rig.calls).toEqual(["a"]);
	await settleOpenReloads();
	expect([...rig.calls].sort()).toEqual(["a", "a follow-up", "b"]);
	expect(rig.peak()).toBe(1);
});

// senpi#7625: a session whose turn comes while it is busy hands the slot on and keeps its change. The session behind
// it reloads without waiting, and the busy one reloads once, at its next idle edge.
it("passes the turn of a session busy at its turn and reloads it at its next idle edge", async () => {
	const rig = reloadRig();
	const [a, b, c] = [rig.instance(), rig.instance(), rig.instance()];
	const [aContext, bContext, cContext] = [rig.context("a"), rig.context("b"), rig.context("c")];
	await a({ type: "session_start", reason: "startup" }, aContext);
	await b({ type: "session_start", reason: "startup" }, bContext);
	await c({ type: "session_start", reason: "startup" }, cContext);
	await rig.change("light");
	expect(rig.calls).toEqual(["a"]);
	rig.busy.add("b");
	await settleOpenReloads();
	await vi.advanceTimersByTimeAsync(RELOAD_SLOT_TIMEOUT_MS);
	expect(rig.calls).toEqual(["a", "c"]);
	rig.busy.delete("b");
	const idleEdge = b({ type: "agent_end" }, bContext);
	await rig.reached("b");
	expect(rig.calls).toEqual(["a", "c", "b"]);
	await settleOpenReloads();
	await idleEdge;
	expect(rig.peak()).toBe(1);
});

// senpi#7625: once the bound releases an overrunning reload's slot the queue is empty, so a follow-up requested from
// that reload's session_start starts at once. It overlaps only the logged overrun, and both reloads finish.
it("starts a follow-up requested after a slot overrun at once, overlapping only the overrun", async () => {
	const rig = reloadRig();
	const overrun = Promise.withResolvers<void>();
	const a = rig.instance();
	const aContext = rig.context("a", async () => {
		await overrun.promise;
		await a({ type: "session_shutdown", reason: "reload" }, aContext);
		rig.writeSettings("changed after the overrun");
		await rig.instance()({ type: "session_start", reason: "reload" }, rig.context("a follow-up"));
	});
	await a({ type: "session_start", reason: "startup" }, aContext);
	await rig.change("light");
	expect(rig.calls).toEqual(["a"]);
	await vi.advanceTimersByTimeAsync(RELOAD_SLOT_TIMEOUT_MS);
	expect(rig.warnings).toEqual(["reload_slot_released"]);
	overrun.resolve();
	await rig.reached("a follow-up");
	expect(rig.calls).toEqual(["a", "a follow-up"]);
	expect(rig.peak()).toBe(2);
	await settleOpenReloads();
	await Promise.all([rig.reached("a done"), rig.reached("a follow-up done")]);
	expect(rig.warnings).toEqual(["reload_slot_released"]);
});
