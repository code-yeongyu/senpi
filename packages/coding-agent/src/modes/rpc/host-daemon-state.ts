/**
 * WHAT the daemon's boot settings say, and the primitives every state file goes through.
 *
 * `settings.json` is written twice on purpose: the daemon directory holds what the SUPERVISOR reads
 * at boot, and the generation's own directory keeps what THAT generation was started with, which
 * survives the next generation overwriting the boot copy.
 *
 * The three primitives below are shared with `host-daemon-registration.ts`: a write that carries the
 * 0600 mode and names the path it failed on, a read that treats a missing file as "no state" rather
 * than an error, and the JSON narrowing both sides parse records with. WHERE any of these files live
 * is `host-daemon-paths.ts`; nothing here builds a path of its own.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
	createGenerationDirectory,
	generationPaths,
	HOST_STATE_FILE_MODE,
	type HostDaemonPaths,
	HostDaemonStateError,
} from "./host-daemon-paths.ts";
/** Settings a supervisor reads at boot. Written before the spawn, so it exists when the host starts. */
export interface HostDaemonSettings {
	readonly socket: string;
	readonly capabilities: readonly string[];
	readonly coldStart: string;
	readonly idleExitMs: number;
	/** Which generation of this daemon the spawn is; `0` for a host nobody has handed off yet. */
	readonly generation: number;
	/** Which generation directory the spawn will register itself in. */
	readonly instanceId: string;
}

/**
 * Publishes the settings a generation is started with, in both places they are read: the daemon
 * directory (what the supervisor loads at boot) and the generation's own directory (what that
 * generation was started with, which survives the next generation overwriting the boot copy).
 */
export async function writeHostSettings(paths: HostDaemonPaths, settings: HostDaemonSettings): Promise<void> {
	const generation = generationPaths(paths, settings.instanceId);
	await createGenerationDirectory(generation);
	await writeStateFile(paths.settingsFile, settings);
	await writeStateFile(generation.settingsFile, settings);
}

/** The policy the running generation was started with, for a successor that states none of its own. */
export async function readHostSettings(
	paths: HostDaemonPaths,
): Promise<{ coldStart?: HostDaemonSettings["coldStart"]; idleExitMs?: number } | undefined> {
	const parsed = parseJson(await readFileOrUndefined(paths.settingsFile));
	if (!parsed) return undefined;
	return {
		...(typeof parsed.coldStart === "string" && { coldStart: parsed.coldStart }),
		...(typeof parsed.idleExitMs === "number" && { idleExitMs: parsed.idleExitMs }),
	};
}

export async function writeStateFile(path: string, content: unknown): Promise<void> {
	try {
		await writeFile(path, `${JSON.stringify(content)}\n`, { mode: HOST_STATE_FILE_MODE });
	} catch (cause) {
		throw new HostDaemonStateError(path, cause);
	}
}

export async function readFileOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ENOTDIR")) return undefined;
		throw error;
	}
}

export function parseJson(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
