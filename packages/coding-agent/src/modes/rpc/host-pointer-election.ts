/**
 * Re-pointing an endpoint whose pointer names no generation (senpi#1911).
 *
 * A prune drops a pointer that names a dead generation, and a live generation can then be left with no
 * pointer at all: an older build's registration raced a newer prune, or a supervisor died after its
 * successor registered. Every reader of the pointer (`host stop`, `host handoff`, `host status`) then
 * reads "no owner" while a healthy host serves the socket, and refuses `unknown_owner`.
 *
 * The pointer is given back only to the ONE generation whose record proves it: the record names this
 * endpoint's public socket and its own instance id, and its pid is alive with the recorded start time.
 * A generation someone is stopping or draining is never a candidate. Zero or several candidates leave
 * the directory without a pointer, and the caller reports which ones it saw. The pointer is created
 * with `link()`, which never replaces a file: a registration that wrote a pointer meanwhile wins.
 */
import { randomUUID } from "node:crypto";
import { access, link, readdir, rm } from "node:fs/promises";
import { parseDaemonPidFile, processMatchesPidFile, readProcessStartTime } from "../../utils/process-identity.ts";
import { generationPaths, HOST_DAEMON_LAYOUT, type HostDaemonPaths, sameEndpoint } from "./host-daemon-paths.ts";
import { isRecord, parseJson, readFileOrUndefined, writeStateFile } from "./host-daemon-state.ts";

/** What the pointer names after an election, for `host status` to report. */
export type HostPointerState =
	| { readonly state: "current" | "elected"; readonly instanceId: string; readonly candidates: readonly string[] }
	| { readonly state: "missing"; readonly instanceId: null; readonly candidates: readonly string[] };

interface Candidate {
	readonly instanceId: string;
	readonly writer: unknown;
}

/**
 * Elects the one proven live generation when the pointer is absent. `write: false` reports what an
 * election would see without writing (`host status --all`, which never mutates the directory).
 */
export async function electPointer(
	paths: HostDaemonPaths,
	options: { readonly write?: boolean } = {},
): Promise<HostPointerState> {
	const text = await readFileOrUndefined(paths.pointerFile).catch(() => undefined);
	if (text !== undefined) {
		const instanceId = parseJson(text)?.instance_id;
		if (typeof instanceId === "string") return { state: "current", instanceId, candidates: [] };
		return { state: "missing", instanceId: null, candidates: [] };
	}
	const candidates = await provenLiveGenerations(paths);
	const ids = candidates.map((candidate) => candidate.instanceId);
	const [only] = candidates;
	if (only === undefined || candidates.length > 1 || options.write === false)
		return { state: "missing", instanceId: null, candidates: ids };
	if (await linkPointer(paths, only)) return { state: "elected", instanceId: only.instanceId, candidates: ids };
	return electPointer(paths, { write: false });
}

async function provenLiveGenerations(paths: HostDaemonPaths): Promise<Candidate[]> {
	const found: Candidate[] = [];
	for (const instanceId of (await readdir(paths.generationsDir).catch(() => [] as string[])).sort()) {
		const generation = generationPaths(paths, instanceId);
		if ((await exists(generation.stopIntentFile)) || (await exists(generation.drainRequestFile))) continue;
		const text = await readFileOrUndefined(generation.pidFile).catch(() => undefined);
		const record = text === undefined ? undefined : parseDaemonPidFile(text);
		const parsed = parseJson(text);
		if (record === undefined || record.processStartTime === null || parsed?.instance_id !== instanceId) continue;
		if (typeof parsed.socket !== "string" || !sameEndpoint(parsed.socket, paths.socket)) continue;
		const identity = { pid: record.pid, processStartTime: record.processStartTime };
		if (await processMatchesPidFile(identity, readProcessStartTime).catch(() => false))
			found.push({ instanceId, writer: parsed.writer });
	}
	return found;
}

/** Creates the pointer only where none exists; false when another writer's pointer is already there. */
async function linkPointer(paths: HostDaemonPaths, candidate: Candidate): Promise<boolean> {
	const staged = `${paths.pointerFile}.elect-${process.pid}-${randomUUID()}.tmp`;
	try {
		await writeStateFile(staged, {
			layout: HOST_DAEMON_LAYOUT,
			instance_id: candidate.instanceId,
			generation_dir: generationPaths(paths, candidate.instanceId).relativeDir,
			...(isRecord(candidate.writer) && { writer: candidate.writer }),
		});
		await link(staged, paths.pointerFile);
		return true;
	} catch {
		return false;
	} finally {
		await rm(staged, { force: true }).catch(() => undefined);
	}
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}
