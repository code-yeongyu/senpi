import { randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";
import { privateRootStat } from "./compact-root-owner.ts";
import { CompactReadError } from "./compact-read-lease.ts";

/**
 * RULING-84: shared durable storage-health clock, independent of accepted sequence and freeze generation.
 * Only a successful real write/fsync or completed repair after a failure advances it. Kernel advisory locking
 * serializes independent owners; temp fsync, rename and directory fsync precede publication of a new revision.
 */
export class RecoveryStorageHealth {
	private readonly dir: string;
	private failures = 0;
	private cleared = 0;
	private pending: Promise<string> | undefined;

	constructor(base = getAgentDir()) {
		this.dir = join(base, `.senpi-recovery-health-${process.getuid?.() ?? "user"}`);
		mkdirSync(this.dir, { mode: 0o700, recursive: true });
		if (!privateRootStat(lstatSync(this.dir))) throw new CompactReadError("ownership");
	}

	get needsRecovery(): boolean {
		return this.failures > this.cleared;
	}
	unavailable(): void {
		this.failures += 1;
	}

	async revision(): Promise<string> {
		return (await this.readRevision()) ?? this.advance();
	}

	/** Corrupt metadata has no usable revision; only a locked atomic repair publishes its replacement. */
	private async readRevision(): Promise<string | undefined> {
		try {
			const handle = await open(join(this.dir, "revision"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const stat = await handle.stat();
				if (!stat.isFile() || stat.size > 128) return undefined;
				const text = (await handle.readFile("utf8")).trim();
				return /^(0|[1-9]\d*)$/.test(text) ? text : undefined;
			} finally {
				await handle.close();
			}
		} catch (cause) {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "0";
			if (cause instanceof Error && "code" in cause && cause.code === "ELOOP") return undefined;
			throw cause;
		}
	}

	/** The operation must actually finish successfully; a refusal leaves both failure and revision unchanged. */
	async recover(operation: () => Promise<void>): Promise<string> {
		const through = this.failures;
		await operation();
		if (through <= this.cleared) return this.revision();
		if (this.pending) await this.pending;
		if (through <= this.cleared) return this.revision();
		this.pending = this.advance().then((revision) => {
			this.cleared = through;
			return revision;
		});
		try {
			return await this.pending;
		} finally {
			this.pending = undefined;
		}
	}

	private async advance(): Promise<string> {
		const release = await acquireOwnershipSafeLock(join(this.dir, "revision.lock"));
		const temporary = join(this.dir, `${randomUUID()}.tmp`);
		try {
			const next = String(BigInt((await this.readRevision()) ?? "0") + 1n);
			const file = await open(
				temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			try {
				await file.writeFile(next);
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, join(this.dir, "revision"));
			const directory = await open(this.dir, "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
			return next;
		} finally {
			try {
				await rm(temporary, { force: true });
			} finally {
				await release();
			}
		}
	}
}
