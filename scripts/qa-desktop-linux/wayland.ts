// Wayland scenarios on `sway --headless`: capability honesty against OS probes, input refused
// without the host-relay opt-in, and input through `LIBEI_SOCKET` into the recording fake EIS server.
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";

import { asObject, Engine, type Json, type JsonObject, outcome } from "./engine.ts";
import { exists, HANG_GUARD_MS, until } from "./procs.ts";
import { type Context, type Result, result } from "./scenario.ts";
import { A11Y_NAME, PORTAL_NAME, type WaylandObserver, type WaylandStage } from "./wayland-env.ts";

/** evdev `KEY_H`, `KEY_I`: the presses `typeText("hi")` must produce on the `us` group. */
const HI_KEYCODES: readonly number[] = [35, 23];

function spawnEngine(ctx: Context, stage: WaylandStage, libei?: string): Engine {
	return Engine.spawn(ctx.engineBinary, ctx.procs.childEnv({ ...stage.env, LIBEI_SOCKET: libei }));
}

async function capabilitiesHonest(ctx: Context, stage: WaylandStage, observe: WaylandObserver): Promise<Result> {
	const engine = spawnEngine(ctx, stage);
	try {
		const before = {
			socketPresent: observe.socketPresent(),
			displayEnv: stage.env.DISPLAY ?? null,
			waylandDisplayEnv: stage.env.WAYLAND_DISPLAY ?? null,
			busNames: await observe.busNames(),
		};
		const portal = await observe.busName(PORTAL_NAME);
		const a11y = await observe.busName(A11Y_NAME);
		const stop = await engine.activate(true);
		const caps = asObject(await engine.result("capabilities"));
		const status = asObject(await engine.result("stopPath.status"));
		const modes = JSON.stringify(caps.deliveryModes);
		const after = { portal, a11y };
		return result(
			"wayland-capabilities-honest",
			{
				wayland_socket_present: before.socketPresent && before.displayEnv === null,
				backend_is_wayland: caps.backend === "wayland" && caps.displayServer === "wayland",
				delivery_modes_background_only: modes === '["background"]',
				capture_matches_portal: portal.present || (caps.capture === false && caps.capturePermission === "unavailable"),
				stop_path_matches_global_shortcuts: portal.present || (status.globalLive === false && caps.stopPath !== "global"),
				ax_permission_matches_a11y_bus: a11y.present === (caps.axPermission !== "bus-unreachable"),
				input_matches_input_paths: portal.present || caps.inputPermission === "unavailable",
			},
			{ capabilities: caps, stopPathStart: stop, stopPathStatus: status },
			{ before, after },
		);
	} finally {
		await engine.close();
	}
}

interface EisLog {
	readonly exited: boolean;
	readonly log: JsonObject | null;
}

function startFakeEis(ctx: Context, name: string): { child: ChildProcess; socket: string; done: Promise<void> } {
	const socket = join(ctx.runDir, `${name}.eis`);
	const child = ctx.procs.start(`fake EIS ${name}`, [ctx.fakeEisBinary, socket, "1"]);
	const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return { child, socket, done };
}

async function readFakeEis(ctx: Context, child: ChildProcess, done: Promise<void>, wait: boolean): Promise<EisLog> {
	if (wait) {
		await Promise.race([done, new Promise((resolve) => setTimeout(resolve, HANG_GUARD_MS))]);
	}
	const exited = child.exitCode !== null;
	if (!exited) child.kill("SIGTERM");
	await done;
	const line = ctx.procs
		.output(child)
		.split("\n")
		.find((text) => text.startsWith("{"));
	const parsed: Json = line === undefined ? null : JSON.parse(line);
	return { exited, log: parsed === null ? null : asObject(parsed) };
}

function pressedKeys(log: JsonObject | null): number[] {
	const events = log?.events;
	if (!Array.isArray(events)) return [];
	return events
		.map((event) => asObject(event))
		.filter((event) => event.kind === "key" && event.pressed === true)
		.map((event) => Number(event.keycode));
}

async function input(ctx: Context, stage: WaylandStage, optIn: boolean, name: string): Promise<Result> {
	const eis = startFakeEis(ctx, name);
	await until(() => exists(eis.socket), "the fake EIS socket");
	const engine = spawnEngine(ctx, stage, eis.socket);
	try {
		const stop = await engine.activate(optIn);
		const before = { eisSocket: eis.socket, allowHostRelayOnlyStop: optIn, globalLive: stop.globalLive ?? null };
		const typed = outcome(await engine.exec("typeText", { target: "desktop", text: "hi" }));
		const eisLog = await readFakeEis(ctx, eis.child, eis.done, typed === "ok");
		const keys = pressedKeys(eisLog.log);
		const after = { eisExited: eisLog.exited, eisLog: eisLog.log, pressedKeys: keys };
		const checks: Record<string, boolean> = optIn
			? {
					type_text_ok: typed === "ok",
					fake_eis_connected: eisLog.log?.connected === true,
					fake_eis_recorded_hi: JSON.stringify(keys) === JSON.stringify(HI_KEYCODES),
				}
			: {
					refused_stop_path_unavailable: typed === "StopPathUnavailable",
					fake_eis_recorded_nothing: keys.length === 0 && eisLog.log === null,
				};
		return result(name, checks, { typeText: typed, stopPathStart: stop }, { before, after });
	} finally {
		await engine.close();
	}
}

export const WAYLAND_SCENARIOS = [
	"wayland-capabilities-honest",
	"wayland-input-refused-without-optin",
	"wayland-input-with-optin",
] as const;
export type WaylandScenario = (typeof WAYLAND_SCENARIOS)[number];

export function runWayland(
	name: WaylandScenario,
	ctx: Context,
	stage: WaylandStage,
	observe: WaylandObserver,
): Promise<Result> {
	switch (name) {
		case "wayland-capabilities-honest":
			return capabilitiesHonest(ctx, stage, observe);
		case "wayland-input-refused-without-optin":
			return input(ctx, stage, false, name);
		case "wayland-input-with-optin":
			return input(ctx, stage, ctx.sabotage !== "skip-optin", name);
	}
}
