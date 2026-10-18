import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import { errorCode } from "./extensions/builtin/terminal/lease-file.ts";
import {
	BOOT_INSTANT_TOLERANCE_MS,
	ownProcessStartedAtMs,
	processBootAtMs,
	sameBoot,
} from "./extensions/builtin/terminal/process-identity.ts";
import { readProcessStartMs } from "./extensions/builtin/terminal/process-start-probe.ts";
import { encodedSessionId } from "./session-sidecar-store.ts";

const WRITERS_DIR = "session-writers";
const CLAIM = /^(\d+)\.json$/;

export interface WriterClaim {
	readonly generation: number;
	readonly nonce: string;
	/** The machine the writer ran on: its pid, boot and start time mean nothing on another host. */
	readonly host: string;
	readonly pid: number;
	readonly bootAtMs: number;
	readonly processStartedAtMs: number;
	readonly canonicalPath: string;
}

export interface WriterProbes {
	readonly pidAlive: (pid: number) => boolean;
	readonly readProcessStartMs: (pid: number) => Promise<number | undefined>;
	readonly bootAtMs: () => number;
	readonly host: () => string;
	readonly self: () => { readonly pid: number; readonly processStartedAtMs: number };
}

export class SessionWriterBusyError extends Error {
	readonly code = "session_writer_busy";
	readonly holder: WriterClaim;
	constructor(holder: WriterClaim) {
		super(`Session is already open for writing by process ${holder.pid}; close it there or open it read-only.`);
		this.name = "SessionWriterBusyError";
		this.holder = holder;
	}
}

export class SessionWriterClaimError extends Error {
	readonly code = "session_writer_claim_invalid";
	constructor(message: string) {
		super(message);
		this.name = "SessionWriterClaimError";
	}
}

export const realWriterProbes: WriterProbes = {
	pidAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return errorCode(error) === "EPERM";
		}
	},
	readProcessStartMs,
	bootAtMs: () => processBootAtMs(),
	host: () => hostname(),
	self: () => ({ pid: process.pid, processStartedAtMs: ownProcessStartedAtMs() }),
};

export function writerClaimsDir(sessionFile: string, sessionId: string): string {
	return join(dirname(resolveMovedPath(sessionFile)), WRITERS_DIR, encodedSessionId(sessionId));
}

/** Takes the next writer generation, only after proving the current owner can no longer write (senpi#3549). */
export async function acquireWriterClaim(
	dir: string,
	canonicalPath: string,
	probes: WriterProbes = realWriterProbes,
): Promise<WriterClaim> {
	await mkdir(dir, { recursive: true });
	const current = await latestClaim(dir);
	if (current !== undefined && !(await ownerGone(dir, current, probes))) throw new SessionWriterBusyError(current);
	const self = probes.self();
	const claim: WriterClaim = {
		generation: (current?.generation ?? 0) + 1,
		nonce: randomUUID(),
		host: probes.host(),
		pid: self.pid,
		bootAtMs: probes.bootAtMs(),
		processStartedAtMs: self.processStartedAtMs,
		canonicalPath,
	};
	try {
		await publishLinked(join(dir, `${claim.generation}.json`), JSON.stringify(claim));
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		const winner = await latestClaim(dir);
		throw winner === undefined ? error : new SessionWriterBusyError(winner);
	}
	return claim;
}

/** True only while `claim` is still the newest generation and has not been released. */
export async function writerClaimIsCurrent(dir: string, claim: WriterClaim): Promise<boolean> {
	const current = await latestClaim(dir);
	if (current?.generation !== claim.generation || current.nonce !== claim.nonce) return false;
	return !(await releasedWith(dir, claim));
}

/** Publishes the nonce-matched release marker; call only once nothing can append, consume or dispatch. */
export async function releaseWriterClaim(dir: string, claim: WriterClaim): Promise<void> {
	try {
		await publishLinked(join(dir, `${claim.generation}.released`), claim.nonce);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
}

async function latestClaim(dir: string): Promise<WriterClaim | undefined> {
	const generations = (await readdir(dir).catch(emptyWhenMissing))
		.map((name) => CLAIM.exec(name)?.[1])
		.filter((value): value is string => value !== undefined)
		.map(Number)
		.sort((a, b) => a - b);
	generations.forEach((generation, index) => {
		if (generation !== index + 1)
			throw new SessionWriterClaimError(`Writer claims in ${dir} have a gap before ${generation}.`);
	});
	const last = generations.at(-1);
	if (last === undefined) return undefined;
	return parseClaim(await readFile(join(dir, `${last}.json`), "utf8"), dir);
}

async function ownerGone(dir: string, claim: WriterClaim, probes: WriterProbes): Promise<boolean> {
	if (await releasedWith(dir, claim)) return true;
	// A writer on another host (a shared or network directory) cannot be probed from here: never displace it.
	if (claim.host !== probes.host()) return false;
	if (!sameBoot(probes.bootAtMs(), claim.bootAtMs)) return true;
	if (!probes.pidAlive(claim.pid)) return true;
	const startedAtMs = await probes.readProcessStartMs(claim.pid);
	if (startedAtMs === undefined) return false;
	return Math.abs(startedAtMs - claim.processStartedAtMs) > BOOT_INSTANT_TOLERANCE_MS;
}

async function releasedWith(dir: string, claim: WriterClaim): Promise<boolean> {
	try {
		return (await readFile(join(dir, `${claim.generation}.released`), "utf8")) === claim.nonce;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function publishLinked(path: string, content: string): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	const file = await open(temp, "wx", 0o600);
	try {
		await file.writeFile(content, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await link(temp, path);
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM") {
			throw new SessionWriterClaimError(`Writer claims need hard links, which ${dirname(path)} does not support.`);
		}
		throw error;
	} finally {
		await unlink(temp).catch(() => undefined);
	}
}

function parseClaim(raw: string, dir: string): WriterClaim {
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("generation" in parsed && typeof parsed.generation === "number") ||
		!("nonce" in parsed && typeof parsed.nonce === "string") ||
		!("host" in parsed && typeof parsed.host === "string") ||
		!("pid" in parsed && typeof parsed.pid === "number") ||
		!("bootAtMs" in parsed && typeof parsed.bootAtMs === "number") ||
		!("processStartedAtMs" in parsed && typeof parsed.processStartedAtMs === "number") ||
		!("canonicalPath" in parsed && typeof parsed.canonicalPath === "string")
	) {
		throw new SessionWriterClaimError(`A writer claim in ${dir} is malformed.`);
	}
	return {
		generation: parsed.generation,
		nonce: parsed.nonce,
		host: parsed.host,
		pid: parsed.pid,
		bootAtMs: parsed.bootAtMs,
		processStartedAtMs: parsed.processStartedAtMs,
		canonicalPath: parsed.canonicalPath,
	};
}

function emptyWhenMissing(error: unknown): string[] {
	if (errorCode(error) === "ENOENT") return [];
	throw error;
}
