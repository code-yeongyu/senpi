import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export type AcquireTerminalLeaseOptions = {
	dir: string;
	encodedSessionId: string;
	pid?: number;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
};

export type AcquireTerminalLeaseResult =
	| { acquired: true; path: string; pid: number }
	| { acquired: false; holder: { pid: number; startedAtMs: number } };

type LeaseRecord = { pid: number; startedAtMs: number };

function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}

function probeAlive(pid: number, probe?: (pid: number) => boolean): boolean {
	try {
		if (probe) return probe(pid);
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EPERM") return true;
		if (code === "ESRCH") return false;
		throw error;
	}
}

async function readLease(path: string): Promise<LeaseRecord | "missing" | "unparseable"> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "missing";
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return "unparseable";
		const pid = (parsed as { pid?: unknown }).pid;
		const startedAtMs = (parsed as { startedAtMs?: unknown }).startedAtMs;
		if (
			typeof pid !== "number" ||
			!Number.isFinite(pid) ||
			typeof startedAtMs !== "number" ||
			!Number.isFinite(startedAtMs)
		) {
			return "unparseable";
		}
		return { pid, startedAtMs };
	} catch {
		return "unparseable";
	}
}

async function exclusiveCreate(path: string, record: LeaseRecord): Promise<void> {
	const file = await open(path, "wx");
	try {
		await file.writeFile(JSON.stringify(record), "utf8");
	} finally {
		await file.close();
	}
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

async function tryAcquire(
	path: string,
	record: LeaseRecord,
	isProcessAlive: ((pid: number) => boolean) | undefined,
	retry: boolean,
): Promise<AcquireTerminalLeaseResult> {
	try {
		await exclusiveCreate(path, record);
		return { acquired: true, path, pid: record.pid };
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		const existing = await readLease(path);
		const reclaimable =
			existing === "missing" || existing === "unparseable" || !probeAlive(existing.pid, isProcessAlive);
		if (reclaimable && retry) {
			await unlinkIfPresent(path);
			return tryAcquire(path, record, isProcessAlive, false);
		}
		if (existing === "missing" || existing === "unparseable") throw error;
		return { acquired: false, holder: existing };
	}
}

export async function acquireTerminalLease(options: AcquireTerminalLeaseOptions): Promise<AcquireTerminalLeaseResult> {
	const pid = options.pid ?? process.pid;
	const startedAtMs = (options.now ?? Date.now)();
	const path = join(options.dir, `${options.encodedSessionId}.lease`);
	await mkdir(options.dir, { recursive: true });
	return tryAcquire(path, { pid, startedAtMs }, options.isProcessAlive, true);
}

export async function releaseTerminalLease(handle: { path: string; pid: number }): Promise<void> {
	const existing = await readLease(handle.path);
	if (existing === "missing" || existing === "unparseable") return;
	if (existing.pid !== handle.pid) return;
	await unlinkIfPresent(handle.path);
}
