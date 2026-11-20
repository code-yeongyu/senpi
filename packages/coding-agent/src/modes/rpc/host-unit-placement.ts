/**
 * Which unit a new generation's supervisor runs in (senpi#7099).
 *
 * A supervisor is setsid'd and reparented, but on Linux it stays in its CALLER's cgroup: when that caller lives in
 * a transient unit (a terminal's per-terminal service, an ssh scope, a CI job), stopping the unit SIGTERMs the shared
 * host with it. Where a user systemd manager answers, the supervisor is therefore started through
 * `systemd-run --user --scope`, which moves itself into a new scope named for the generation and then EXECS the
 * supervisor argv in place: the spawned pid is the supervisor itself, every inherited descriptor (the owner pipe at
 * 3, the presenter channel at 4, the startup pipe, private fds) survives, and `--collect` unloads the scope once the
 * generation exits. No live process is ever moved between cgroups. The probe creates one throwaway scope first: a
 * manager that answers but refuses transient scopes (no cgroup delegation, bus policy) keeps the spawn unchanged
 * instead of failing the start. Without a reachable manager (containers, CI without systemd, macOS) the spawn is
 * unchanged too, and `host ensure` / `host status` name the unit the host's lifetime is tied to (`readHostUnit`).
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

const HOST_UNIT_PREFIX = "senpi-host-";
const MANAGER_PROBE_TIMEOUT_MS = 2_000;
/** `is-system-running` states in which the user manager answers and accepts a transient unit. */
function managerAnswers(state: string): boolean {
	return ["running", "degraded", "starting", "initializing", "maintenance"].includes(state);
}

/** One generation, one scope: the instance id makes the name unique per generation. */
export function hostUnitName(instanceId: string): string {
	return `${HOST_UNIT_PREFIX}${instanceId}.scope`;
}

export interface HostUnitProbe {
	readonly platform: NodeJS.Platform;
	/** Whether `systemctl --user is-system-running` answered for this environment. */
	readonly userManager: boolean;
	/** `systemd-run` resolved on this environment's PATH. */
	readonly systemdRun: string | undefined;
	/** Whether that `systemd-run` could start a transient user scope just now. */
	readonly scopeAccepted: boolean;
}

export type HostUnitPlacement =
	| { readonly kind: "own_unit"; readonly unit: string; readonly systemdRun: string }
	| {
			readonly kind: "caller_unit";
			readonly reason: "not_linux" | "no_user_manager" | "no_systemd_run" | "scope_refused";
	  };

export function decideHostUnitPlacement(instanceId: string, probe: HostUnitProbe): HostUnitPlacement {
	if (probe.platform !== "linux") return { kind: "caller_unit", reason: "not_linux" };
	if (!probe.userManager) return { kind: "caller_unit", reason: "no_user_manager" };
	if (probe.systemdRun === undefined) return { kind: "caller_unit", reason: "no_systemd_run" };
	if (!probe.scopeAccepted) return { kind: "caller_unit", reason: "scope_refused" };
	return { kind: "own_unit", unit: hostUnitName(instanceId), systemdRun: probe.systemdRun };
}

export interface HostLaunchCommand {
	readonly command: string;
	readonly args: readonly string[];
}

export function placedLaunch(launch: HostLaunchCommand, placement: HostUnitPlacement): HostLaunchCommand {
	if (placement.kind === "caller_unit") return launch;
	return {
		command: placement.systemdRun,
		args: [
			"--user",
			"--scope",
			`--unit=${placement.unit}`,
			"--collect",
			"--quiet",
			"--",
			launch.command,
			...launch.args,
		],
	};
}

/** What the placement needs to know about `env`, the environment the supervisor is spawned with. */
export async function probeHostUnitPlacement(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): Promise<HostUnitProbe> {
	if (platform !== "linux" || !env.XDG_RUNTIME_DIR)
		return { platform, userManager: false, systemdRun: undefined, scopeAccepted: false };
	const [userManager, systemdRun] = await Promise.all([userManagerAnswers(env), onPath("systemd-run", env.PATH)]);
	const scopeAccepted = userManager && systemdRun !== undefined && (await scopeStarts(systemdRun, env));
	return { platform, userManager, systemdRun, scopeAccepted };
}

/** The launch a generation is spawned with: in its own scope where the user manager answers, else unchanged. */
export async function placeHostLaunch(
	launch: HostLaunchCommand,
	instanceId: string,
	env: NodeJS.ProcessEnv,
): Promise<HostLaunchCommand> {
	return placedLaunch(launch, decideHostUnitPlacement(instanceId, await probeHostUnitPlacement(env)));
}

function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { PATH: env.PATH ?? "", XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR ?? "" };
}

/** The real placement's own command with `true` as the payload: a refused scope shows here, not at the spawn. */
function scopeStarts(systemdRun: string, env: NodeJS.ProcessEnv): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(systemdRun, ["--user", "--scope", "--collect", "--quiet", "--", "true"], {
			env: probeEnv(env),
			stdio: "ignore",
			timeout: MANAGER_PROBE_TIMEOUT_MS,
		});
		child.once("error", () => resolve(false));
		child.once("close", (code) => resolve(code === 0));
	});
}

function userManagerAnswers(env: NodeJS.ProcessEnv): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("systemctl", ["--user", "is-system-running"], {
			env: probeEnv(env),
			stdio: ["ignore", "pipe", "ignore"],
			timeout: MANAGER_PROBE_TIMEOUT_MS,
		});
		let stdout = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.once("error", () => resolve(false));
		child.once("close", () => resolve(managerAnswers(stdout.trim())));
	});
}

async function onPath(program: string, path: string | undefined): Promise<string | undefined> {
	for (const dir of (path ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, program);
		if (
			await access(candidate, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return candidate;
	}
	return undefined;
}

/** The cgroup a generation's supervisor runs in, and whether it is that generation's own unit. */
export interface HostUnit {
	readonly cgroup: string;
	/** The `.service` / `.scope` unit owning that cgroup; stopping it ends the generation. */
	readonly name: string | null;
	/** True when `name` is the generation's own scope, so no caller's unit decides its lifetime. */
	readonly own: boolean;
}

/** Status rows with the unit each live generation's supervisor runs in; an ended one has none. */
export function withHostUnits<
	Row extends { readonly pid: number; readonly instanceId: string; readonly alive: boolean },
>(rows: readonly Row[]): Promise<(Row & { readonly unit: HostUnit | null })[]> {
	return Promise.all(
		rows.map(async (row) => ({ ...row, unit: row.alive ? await readHostUnit(row.pid, row.instanceId) : null })),
	);
}

/**
 * The `host ensure` / `host handoff` answer: the unit, and `lifetime_tied_to` naming the unit whose stop would end
 * the host when it is not the generation's own.
 */
export async function hostUnitPayload(
	pid: number,
	instanceId: string | undefined,
): Promise<{ unit: HostUnit | null; lifetime_tied_to?: string }> {
	const unit = await readHostUnit(pid, instanceId);
	return unit !== null && !unit.own && unit.name !== null ? { unit, lifetime_tied_to: unit.name } : { unit };
}

/** `null` off Linux or when the process's cgroup cannot be read. */
export async function readHostUnit(pid: number, instanceId: string | undefined): Promise<HostUnit | null> {
	if (process.platform !== "linux") return null;
	const table = await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => undefined);
	return table === undefined ? null : hostUnitFromCgroupTable(table, instanceId);
}

export function hostUnitFromCgroupTable(table: string, instanceId: string | undefined): HostUnit | null {
	const lines = table.split("\n");
	const entry = lines.find((line) => line.startsWith("0::")) ?? lines.find((line) => line.includes(":name=systemd:"));
	if (entry === undefined) return null;
	const cgroup = entry.slice(entry.indexOf(":", entry.indexOf(":") + 1) + 1);
	const leaf = cgroup.slice(cgroup.lastIndexOf("/") + 1);
	const name = /\.(service|scope)$/u.test(leaf) ? leaf : null;
	return { cgroup, name, own: name !== null && instanceId !== undefined && name === hostUnitName(instanceId) };
}
