/**
 * The provenance a reserving owner records beside the daemon rows its launch writes (sisyphuslabs/omo-desktop-app#4199,
 * design 4.2a "Process evidence and the kernel-session gate (Revision 8)"). A generation directory's supervisor pidfile,
 * host-child pidfile and session claims are written by the processes of one launch: the reserving owner spawned the
 * supervisor and granted it, and the supervisor granted the host, each through a handle on its own kernel (clause ii),
 * so every row under that directory was written in the owner's kernel session. The owner records that session, the
 * reservation generation it launched, and whether the daemon directory classified `local` from its opened handle at the
 * write. A recovery census then applies clauses (i) and (iii) to each row from this record: a row with no provenance
 * (a legacy or foreign writer) has none to apply and stays unknown. The record carries no credential and no nonce.
 */
import { readFile } from "node:fs/promises";
import type { KernelSessionRecord } from "./endpoint-reservation-store.ts";
import { writeJsonAtomic } from "./host-state-json.ts";

export interface LaunchProvenance {
	/** The reservation generation whose launch writes this directory. */
	readonly generation: string;
	/** The reserving owner's kernel session at the launch; `unverified` equals nothing (clause iv). */
	readonly kernelSession: KernelSessionRecord;
	/** Whether the daemon directory classified `local` from its opened handle when the owner wrote the record. */
	readonly directoryLocal: boolean;
}

export const LAUNCH_PROVENANCE_SCHEMA = 1;

/** Writes the record atomically, before the launch spawns anything that could write a row beside it. */
export async function recordLaunchProvenance(file: string, provenance: LaunchProvenance): Promise<void> {
	await writeJsonAtomic(file, {
		schema: LAUNCH_PROVENANCE_SCHEMA,
		generation: provenance.generation,
		kernelSession:
			provenance.kernelSession.status === "verified"
				? { status: "verified", value: provenance.kernelSession.value }
				: { status: "unverified", reason: provenance.kernelSession.reason },
		directoryLocal: provenance.directoryLocal,
	});
}

export type LaunchProvenanceRead =
	| { readonly status: "recorded"; readonly provenance: LaunchProvenance }
	/** No record: the directory's rows were written by a launch that recorded none (legacy, or another runtime). */
	| { readonly status: "none" }
	/** A record that exists but cannot be read or parsed: incomplete discovery, never "none". */
	| { readonly status: "unreadable"; readonly detail: string };

/** Reads the record; a malformed or unreadable one is reported as such, never read as absent. */
export async function readLaunchProvenance(file: string): Promise<LaunchProvenance | undefined> {
	const read = await readLaunchProvenanceRecord(file);
	return read.status === "recorded" ? read.provenance : undefined;
}

export async function readLaunchProvenanceRecord(file: string): Promise<LaunchProvenanceRead> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
		return { status: "unreadable", detail: error instanceof Error ? error.message : String(error) };
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { status: "unreadable", detail: "malformed launch provenance" };
	}
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		return { status: "unreadable", detail: "malformed launch provenance" };
	}
	const parsed = json as Record<string, unknown>;
	const session = parsed.kernelSession;
	const status = typeof session === "object" && session !== null ? Reflect.get(session, "status") : undefined;
	const value = typeof session === "object" && session !== null ? Reflect.get(session, "value") : undefined;
	const reason = typeof session === "object" && session !== null ? Reflect.get(session, "reason") : undefined;
	const kernelSession: KernelSessionRecord | undefined =
		status === "verified" && typeof value === "string"
			? { status: "verified", value }
			: status === "unverified"
				? { status: "unverified", reason: typeof reason === "string" ? reason : "unrecorded" }
				: undefined;
	if (
		parsed.schema !== LAUNCH_PROVENANCE_SCHEMA ||
		typeof parsed.generation !== "string" ||
		kernelSession === undefined ||
		typeof parsed.directoryLocal !== "boolean"
	) {
		return { status: "unreadable", detail: "malformed launch provenance" };
	}
	return {
		status: "recorded",
		provenance: { generation: parsed.generation, kernelSession, directoryLocal: parsed.directoryLocal },
	};
}
