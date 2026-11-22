/**
 * `qa_spawn`: launches a fixture command with one of the six launch APIs. The command is wrapped so it
 * first writes its marker (`marker-<launchId>`: its pid and process group) atomically into the control
 * directory, then - with `gate` - blocks reading the FIFO `gate-<launchId>` until the driver's
 * `release-gate`, then `exec`s the real argv. Containment and lifetime are read from that marker, so
 * every API reports the same way. Until the launch barrier lands (todo 4) the launch is direct.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileCreated } from "./file-created.ts";

type BunStdio = readonly ["ignore", "ignore", "ignore"];
interface BunShellPromise extends PromiseLike<{ readonly exitCode: number }> {
	quiet(): BunShellPromise;
	nothrow(): BunShellPromise;
}
// Keep the source/Node build independent of Bun's ambient type declarations.
declare const Bun: {
	spawn(
		command: string[],
		options: { stdio: BunStdio; detached?: boolean },
	): { readonly exited: Promise<number>; unref(): void };
	spawnSync(command: string[], options: { stdio: BunStdio }): { readonly exitCode: number };
	$(strings: TemplateStringsArray, ...values: unknown[]): BunShellPromise;
};

export type SpawnApi = "bun.spawn" | "bun.spawnSync" | "bun.shell" | "cp.spawn" | "cp.spawnSync" | "cp.execFileSync";

export interface SpawnFixtureParams {
	readonly api: SpawnApi;
	readonly argv: readonly string[];
	readonly detached?: boolean;
	readonly viaShell?: boolean;
	readonly gate?: boolean;
}

export interface SpawnFixtureResult {
	readonly pid?: number;
	readonly pgid?: number;
	readonly jobId?: string;
	readonly containment: "own-group" | "inherited" | "none";
	readonly lifetime: "owned" | "detached";
	readonly markerSeen: boolean;
	readonly exitCode?: number;
}

const DETACHABLE: ReadonlySet<SpawnApi> = new Set(["bun.spawn", "cp.spawn"]);

const WRAPPER = [
	'printf "%s %s\\n" "$$" "$(ps -o pgid= -p $$ | tr -d " ")" > "$1.tmp" && mv "$1.tmp" "$1"',
	'if [ "$2" != "-" ]; then cat "$2" > /dev/null; fi',
	"shift 2",
	'exec "$@"',
].join("\n");

function readMarker(path: string): { pid: number; pgid: number } | undefined {
	if (!existsSync(path)) return undefined;
	const [pid, pgid] = readFileSync(path, "utf8").trim().split(/\s+/).map(Number);
	return pid && pgid ? { pid, pgid } : undefined;
}

function exitedWith(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
}

function execFileStatus(argv: readonly string[]): number {
	try {
		execFileSync(argv[0] ?? "true", argv.slice(1), { stdio: "ignore" });
		return 0;
	} catch (error) {
		return error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 1;
	}
}

// `requested` is the caller's own `detached` (absent when the tool call did not set it), so the launch API sees exactly
// what an ordinary caller would pass.
async function launch(
	api: SpawnApi,
	argv: readonly string[],
	requested: boolean | undefined,
): Promise<number | undefined> {
	const detached = requested === true;
	const detachOption = requested === undefined ? {} : { detached: requested };
	const [command = "sh", ...args] = argv;
	switch (api) {
		case "cp.spawn": {
			const child = spawn(command, args, { stdio: "ignore", ...detachOption });
			if (!detached) return exitedWith(child);
			child.unref();
			return undefined;
		}
		case "cp.spawnSync":
			return spawnSync(command, args, { stdio: "ignore" }).status ?? 1;
		case "cp.execFileSync":
			return execFileStatus(argv);
		case "bun.spawn": {
			const child = Bun.spawn([command, ...args], { stdio: ["ignore", "ignore", "ignore"], ...detachOption });
			if (!detached) return child.exited;
			child.unref();
			return undefined;
		}
		case "bun.spawnSync":
			return Bun.spawnSync([command, ...args], { stdio: ["ignore", "ignore", "ignore"] }).exitCode;
		case "bun.shell":
			return (await Bun.$`${command} ${args}`.quiet().nothrow()).exitCode;
	}
}

export async function spawnFixture(
	params: SpawnFixtureParams,
	options: { readonly controlDir: string; readonly launchId: string },
): Promise<SpawnFixtureResult> {
	if (process.platform === "win32")
		throw new Error("qa_spawn_windows_unsupported: the Windows path lands with todo 4");
	const detached = params.detached === true;
	if (detached && !DETACHABLE.has(params.api)) throw new Error(`detached_unsupported: ${params.api} cannot detach`);
	const markerName = `marker-${options.launchId}`;
	const markerPath = join(options.controlDir, markerName);
	const gatePath = params.gate === true ? join(options.controlDir, `gate-${options.launchId}`) : "-";
	if (params.gate === true) execFileSync("mkfifo", [gatePath]);
	const inner = params.viaShell === true ? ["sh", "-c", params.argv.join(" ")] : params.argv;
	const wrapped = ["sh", "-c", WRAPPER, "qa-spawn", markerPath, gatePath, ...inner];
	const marker = detached ? fileCreated(options.controlDir, markerName) : undefined;
	const exitCode = await launch(params.api, wrapped, params.detached);
	await marker;
	const identity = readMarker(markerPath);
	return {
		...(identity ? { pid: identity.pid, pgid: identity.pgid } : {}),
		containment: identity === undefined ? "none" : identity.pgid === identity.pid ? "own-group" : "inherited",
		lifetime: detached ? "detached" : "owned",
		markerSeen: identity !== undefined,
		...(exitCode === undefined ? {} : { exitCode }),
	};
}
