/**
 * The per-row detail of a status report: the sessions a host listed and the session-path claims its
 * endpoint's `reservations/` directory holds.
 *
 * Both are parsed here from what the host and the directory SAY, at the boundary, so the report
 * carries typed rows and never a raw reply. The listing is the same `list_sessions` reply the counts
 * are made from; the claims are read from the directory every generation of the endpoint shares, so
 * a path a draining predecessor still holds is visible even though the answering generation's own
 * listing no longer names it.
 */
import type { HostDaemonDirectory } from "./host-daemon-paths.ts";
import type { HostGenerationRow } from "./host-generations.ts";
import { claimOwnerIsLive, readSessionPathClaims } from "./host-reservations.ts";

/** The per-session heap split a host published on its listing (senpi#1960); zeros when none was published. */
export interface HostSessionRowMemory {
	readonly main_heap_mb: number;
	readonly kernel_heap_mb: number;
	readonly kernel_count: number;
}

/** One session the host listed, with the canonical path a client matches it by. */
export interface HostSessionRow {
	readonly id: string;
	readonly kind: string;
	readonly session_path: string | null;
	readonly cwd: string | null;
	readonly name: string | null;
	readonly attachments: number;
	/** The labels published on a worker listing; `null` when the host published none. */
	readonly context: Readonly<Record<string, string>> | null;
	/** The heap split the host published; `{0,0,0}` for a pre-field host. */
	readonly memory: HostSessionRowMemory;
}

/** One session-path claim, whichever generation of the endpoint wrote it. */
export interface HostPathClaimRow {
	readonly session_path: string;
	readonly owner_pid: number;
	readonly instance_id: string;
	/** The owner generation's ordinal, `null` once its generation record is gone. */
	readonly generation: number | null;
	/** Whether the owner had a client attached when it last published; `null` for a pre-flag claim. */
	readonly attached: boolean | null;
	readonly live: boolean;
}

const BYTES_PER_MB = 1024 * 1024;

export function parseSessionRows(reply: unknown): readonly HostSessionRow[] {
	if (!isRecord(reply) || !Array.isArray(reply.sessions)) return [];
	return reply.sessions.flatMap((entry: unknown) => {
		if (!isRecord(entry)) return [];
		return [
			{
				id: typeof entry.sessionId === "string" ? entry.sessionId : "",
				kind: typeof entry.kind === "string" ? entry.kind : "interactive",
				session_path: typeof entry.sessionPath === "string" ? entry.sessionPath : null,
				cwd: typeof entry.cwd === "string" ? entry.cwd : null,
				name: typeof entry.name === "string" ? entry.name : null,
				attachments: typeof entry.attachments === "number" ? entry.attachments : 0,
				context: stringRecord(entry.context),
				memory: parseRowMemory(entry.memory),
			},
		];
	});
}

/** The wire block `{ main_heap_bytes, kernel_heap_bytes, kernel_count }` as megabytes; zeros when absent. */
function parseRowMemory(value: unknown): HostSessionRowMemory {
	if (!isRecord(value)) return { main_heap_mb: 0, kernel_heap_mb: 0, kernel_count: 0 };
	const toMb = (bytes: unknown): number =>
		typeof bytes === "number" && Number.isFinite(bytes) ? Math.round(bytes / BYTES_PER_MB) : 0;
	const count = value.kernel_count;
	return {
		main_heap_mb: toMb(value.main_heap_bytes),
		kernel_heap_mb: toMb(value.kernel_heap_bytes),
		kernel_count: typeof count === "number" && Number.isFinite(count) ? count : 0,
	};
}

export async function readClaimRows(
	paths: HostDaemonDirectory,
	generations: readonly HostGenerationRow[],
): Promise<readonly HostPathClaimRow[]> {
	const rows: HostPathClaimRow[] = [];
	for (const claim of await readSessionPathClaims(paths.reservationsDir)) {
		const owner = claim.owner;
		rows.push({
			session_path: owner.sessionPath,
			owner_pid: owner.pid,
			instance_id: owner.instanceId,
			generation: generations.find((row) => row.instanceId === owner.instanceId)?.generation ?? null,
			attached: owner.attached ?? null,
			live: await claimOwnerIsLive(owner),
		});
	}
	return rows.sort((left, right) => left.session_path.localeCompare(right.session_path));
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
	if (!isRecord(value)) return null;
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
