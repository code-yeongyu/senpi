import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CompactReadError } from "./compact-read-lease.ts";
import { privateRootStat } from "./compact-root-owner.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

const RANGE = 1024;
async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/**
 * RULING-99: a session's single counter, not a socket/epoch counter. Registries bind the durable identity before
 * admission. Anonymous standalone lanes keep a memory counter; a failed durable binding NEVER falls back to it.
 * A lifetime kernel lock excludes concurrent owners, including other hosts. A crash releases the lock, but burns
 * the whole fsynced range. Synchronous freezes issue only reserved values, preserving cut/suffix ordering.
 */
export class SessionGenerations {
	private issued = 0;
	private ceiling = Number.MAX_SAFE_INTEGER;
	private failed = false;
	private closed = false;
	private binding = 0;
	private path: string | undefined;
	private release: (() => Promise<void>) | undefined;
	private pending: Promise<void> = Promise.resolve();
	private readonly dir: string;
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.dir = join(agentDir, `.senpi-recovery-generations-${process.getuid?.() ?? "user"}`);
	}

	/** Replacement burns the old range and reserves above both the lane ceiling and the target's durable floor. */
	bind(sessionId: string): Promise<void> {
		const path = join(this.dir, createHash("sha256").update(sessionId).digest("hex"));
		if (this.closed || path === this.path) return this.pending;
		const previous = this.path;
		this.path = path;
		this.binding++;
		// Drain an old refill before releasing its lock or letting it change the new owner's ceiling.
		this.pending = this.pending
			.then(async () => {
				await this.release?.();
				this.release = undefined;
				this.failed = false;
				this.issued = this.ceiling = previous ? Math.max(this.issued, this.ceiling) : this.issued;
				await this.initialize(path);
			})
			.catch((cause: unknown) => this.unavailable(cause))
			.finally(() => {
				this.binding--;
			});
		return this.pending;
	}

	private async initialize(path: string): Promise<void> {
		await mkdir(this.dir, { mode: 0o700, recursive: true });
		if (!privateRootStat(await lstat(this.dir))) throw new CompactReadError("ownership");
		await syncDirectory(this.agentDir);
		// No synchronous contention wait on the shared loop, and no takeover of a live owner.
		this.release = await acquireOwnershipSafeLock(`${path}.lock`, {
			retries: { retries: 0, minTimeout: 0, maxTimeout: 1 },
		});
		try {
			const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > 32) throw new CompactReadError("integrity");
				const text = await file.readFile("utf8");
				const floor = Number(text);
				if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(floor)) throw new CompactReadError("integrity");
				this.issued = this.ceiling = Math.max(this.issued, floor);
			} finally {
				await file.close();
			}
		} catch (cause) {
			if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		}
		await this.reserve(path);
	}

	/** Exhaustion while refill is pending, corruption, contention and failed persistence all refuse issuance. */
	next(): number | undefined {
		if (this.closed || this.failed || this.binding > 0 || this.issued >= this.ceiling) return undefined;
		const generation = ++this.issued;
		if (this.path && this.ceiling - generation === RANGE / 2)
			this.pending = this.reserve(this.path).catch((cause: unknown) => this.unavailable(cause));
		return generation;
	}

	private async reserve(path: string): Promise<void> {
		const next = Math.min(Number.MAX_SAFE_INTEGER, this.ceiling + RANGE);
		if (next <= this.ceiling) throw new CompactReadError("unavailable");
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
			try {
				await file.writeFile(String(next));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, path);
			await syncDirectory(this.dir);
			this.ceiling = next;
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private unavailable(cause: unknown): void {
		this.failed = true;
		if (!(cause instanceof Error)) throw cause;
	}

	idle(): Promise<void> {
		return this.pending;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.pending = this.pending.then(async () => {
			await this.release?.();
			this.release = undefined;
		});
	}
}
