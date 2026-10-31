/**
 * The server-owned record of every process a tool child is about to start (senpi#3566, plan todo 4).
 *
 * An entry is appended and fsynced before the server sends `launch_ack`, so a containment handle is on disk before the
 * command can run. That is what lets the server clean up descendants even when the child that started them is gone.
 */
import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LaunchApi, LaunchContainment, LaunchLifetime, LaunchOrigin } from "./protocol.ts";

/** Where a generation's ledger lives under a session's tool-child directory; the server writes it, the child reads it. */
export function generationLedgerPath(dir: string, generation: number): string {
	return join(dir, `g${generation}`, "descendants.ledger");
}

export interface DescendantEntry {
	readonly launchId: string;
	readonly generation: number;
	readonly origin: LaunchOrigin;
	readonly api: LaunchApi;
	readonly containment: LaunchContainment;
	readonly lifetime: LaunchLifetime;
	readonly pid?: number;
	readonly pgid?: number;
	readonly leaderStart?: string;
	readonly atMs: number;
}

export class DescendantsLedger {
	readonly #path: string;
	#durableDir = false;
	readonly #entries = new Map<string, DescendantEntry>();

	constructor(path: string) {
		this.#path = path;
	}

	get path(): string {
		return this.#path;
	}

	entries(): DescendantEntry[] {
		return [...this.#entries.values()];
	}

	async append(entry: DescendantEntry): Promise<void> {
		if (!this.#durableDir) {
			// The first entry creates the generation directory and the file: both directory entries are synced, or a crash
			// could leave an fsynced ledger that no directory names.
			const directory = dirname(this.#path);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const created = await open(this.#path, "a", 0o600);
			await created.close();
			await syncDirectory(directory);
			await syncDirectory(dirname(directory));
			this.#durableDir = true;
		}
		const handle = await open(this.#path, "a", 0o600);
		try {
			await handle.write(`${JSON.stringify(entry)}\n`);
			await handle.datasync();
		} finally {
			await handle.close();
		}
		this.#entries.set(entry.launchId, entry);
	}

	/** Entries a previous server instance left behind (crash recovery). A torn final line is ignored. */
	static async readPersisted(path: string): Promise<DescendantEntry[]> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			return [];
		}
		const entries: DescendantEntry[] = [];
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line) as DescendantEntry);
			} catch {
				// A torn last line from a crash mid-append; earlier lines were fsynced whole.
			}
		}
		return entries;
	}

	async remove(): Promise<void> {
		this.#entries.clear();
		await rm(this.#path, { force: true });
	}
}

/** fsync a directory so the entries created in it survive a crash; a platform that cannot open a directory skips it. */
async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Append-only record of every barrier frame, for diagnostics and the QA driver. Not fsynced. */
export class LaunchLog {
	readonly #path: string;
	#chain: Promise<void> = Promise.resolve();
	#failedWrites = 0;

	constructor(path: string) {
		this.#path = path;
	}

	get path(): string {
		return this.#path;
	}

	/** Records the log could not write; the log is diagnostic, so a failed write is counted, never thrown. */
	get failedWrites(): number {
		return this.#failedWrites;
	}

	settled(): Promise<void> {
		return this.#chain;
	}

	/** Appends in order. Never rejects: one failed write neither poisons later records nor what awaits settled(). */
	record(record: Readonly<Record<string, unknown>>): Promise<void> {
		const line = `${JSON.stringify({ atMs: Date.now(), ...record })}\n`;
		this.#chain = this.#chain.then(async () => {
			try {
				await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
				await appendFile(this.#path, line, { mode: 0o600 });
			} catch {
				this.#failedWrites += 1;
			}
		});
		return this.#chain;
	}
}
