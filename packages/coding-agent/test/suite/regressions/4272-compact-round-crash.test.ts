import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { nodeCompactStorageIo } from "../../../src/modes/rpc/compact-storage-io.ts";
import { SPREAD_KEYS, spreadRoundRig, spreadSpoolRoot } from "./4272-spread-round-support.ts";

const ROWS = 1_024;
const isRoundFile = (name: string) => /^node-/.test(name);

async function spoolFiles(dir: string): Promise<Map<string, number>> {
	const files = new Map<string, number>();
	for (const name of await readdir(dir)) files.set(name, (await stat(join(dir, name))).size);
	return files;
}

/**
 * Injected write failure after file k: the round's `failAfter`-th node file reaches disk, then its write reports
 * a failure. The process stays alive, so no later write runs and the strays are reclaimed in process.
 */
async function failedRound(dir: string, failAfter: number) {
	let armed = false;
	let written = 0;
	const rig = spreadRoundRig(ROWS, dir, {
		...nodeCompactStorageIo,
		async writeFile(path, data) {
			await nodeCompactStorageIo.writeFile(path, data);
			if (armed && isRoundFile(path.slice(dir.length + 1)) && ++written === failAfter) {
				throw new Error(`injected write failure after round file ${failAfter}`);
			}
		},
	});
	await rig.settle();
	const before = { base: rig.index.base, pages: [...rig.index.pages], files: await spoolFiles(dir) };
	armed = true;
	await rig.round();
	return { rig, before, written };
}

// senpi#4539 / RULING-54 condition 1: a multi-file round is visible only through its one commit, which comes
// after every file is durable; with an injected write failure after ANY of its files, the previous state stays
// fully readable and the live process reclaims every stray file.
it("keeps the previous state readable and reclaims every stray file after an injected write failure at each file", async () => {
	const probe = await spreadSpoolRoot();
	let roundFiles = 0;
	const whole = spreadRoundRig(ROWS, probe.dir, nodeCompactStorageIo);
	try {
		await whole.settle();
		roundFiles = (await whole.round()).filter((file) => isRoundFile(file.name)).length;
	} finally {
		await whole.store.retire();
		await probe.cleanup();
	}
	expect(roundFiles, "node files in one spread round").toBe(9);
	for (let failAfter = 1; failAfter <= roundFiles; failAfter++) {
		const root = await spreadSpoolRoot();
		const { rig, before, written } = await failedRound(root.dir, failAfter);
		const at = `injected write failure after file ${failAfter} of ${roundFiles}`;
		try {
			expect(written, at).toBe(failAfter);
			expect(rig.store.status(), at).toMatchObject({ spillHalted: true, reclaimDebtBytes: 0 });
			expect(rig.store.status().failures, at).toEqual(
				expect.arrayContaining([expect.objectContaining({ operation: "node_write" })]),
			);
			expect(rig.index.base, at).toBe(before.base);
			expect([...rig.index.pages], at).toEqual(before.pages);
			expect(rig.index.status(), at).toMatchObject({ baseRows: ROWS, overrideSlots: SPREAD_KEYS });
			expect(await spoolFiles(root.dir), `${at}: spool files unchanged, strays reclaimed`).toEqual(before.files);
			const cut = rig.index.freeze();
			try {
				const rows = await rig.index.entries(cut);
				expect(rows.size, at).toBe(ROWS + SPREAD_KEYS);
				expect(rows.get("0512"), at).toEqual({ n: 512 });
				expect(rows.get(rig.spreadKey(5)), at).toEqual({ n: -5 });
				expect(await rig.index.lookup(cut, "1023"), at).toMatchObject({ payload: expect.any(Number) });
			} finally {
				rig.index.release(cut);
			}
		} finally {
			await rig.store.retire();
			await root.cleanup();
		}
	}
}, 120_000);

// senpi#4545 / RULING-55 condition 1, the real crash: a process that dies mid-round never reclaims, commits or
// retires, so its partial node files stay in an orphaned epoch directory. A store reopened on that very directory
// refuses it as pre_existing, never reads, writes or removes a file in it, and the rows are rebuilt from the
// transcript. (In production each lane bootstrap picks a fresh `senpi-settled-<uuid>` directory, so a reopen
// never even names the orphan; nothing sweeps it, the OS temp cleaner does.)
it("refuses a crashed epoch directory holding partial round files and rebuilds the rows from the transcript", async () => {
	const root = await spreadSpoolRoot();
	const cutAfter = 3;
	let armed = false;
	let written = 0;
	const died = Promise.withResolvers<void>();
	const crashed = spreadRoundRig(ROWS, root.dir, {
		...nodeCompactStorageIo,
		async writeFile(path, data) {
			if (armed && isRoundFile(basename(path)) && written === cutAfter) {
				died.resolve();
				// The process is gone: this write, the commit and any reclamation never run.
				return new Promise<never>(() => {});
			}
			await nodeCompactStorageIo.writeFile(path, data);
			if (armed && isRoundFile(basename(path))) written++;
		},
	});
	try {
		await crashed.settle();
		const settled = await spoolFiles(root.dir);
		armed = true;
		void crashed.round();
		await died.promise;
		const left = await spoolFiles(root.dir);
		const partial = [...left.keys()].filter((name) => isRoundFile(name) && !settled.has(name));
		expect(partial, "partial round files the crash left on disk").toHaveLength(cutAfter);

		const calls: string[] = [];
		const reopened = spreadRoundRig(ROWS, root.dir, {
			async writeFile(path, data) {
				calls.push(`write ${basename(path)}`);
				await nodeCompactStorageIo.writeFile(path, data);
			},
			async readFile(path, range) {
				calls.push(`read ${basename(path)}`);
				return nodeCompactStorageIo.readFile(path, range);
			},
			async unlink(path) {
				calls.push(`unlink ${basename(path)}`);
				await nodeCompactStorageIo.unlink(path);
			},
		});
		// The transcript is the source of truth: every settled row and spread key is applied again.
		await reopened.settle();
		expect(reopened.store.status()).toMatchObject({
			spillHalted: true,
			spilledLiveBytes: 0,
			structuredBytes: { spilled: 0 },
			failures: [{ operation: "spool_create", path: root.dir, cause: expect.stringContaining("pre_existing") }],
		});
		expect(calls, "no file of the crashed epoch is read, written or removed").toEqual([]);
		expect(await spoolFiles(root.dir), "the crashed epoch directory is left as found").toEqual(left);
		const cut = reopened.index.freeze();
		try {
			const rows = await reopened.index.entries(cut);
			expect(rows.size).toBe(ROWS + SPREAD_KEYS);
			expect(rows.get("0512")).toEqual({ n: 512 });
			expect(rows.get(reopened.spreadKey(5))).toEqual({ n: -5 });
			expect(await reopened.index.lookup(cut, "1023")).toMatchObject({ payload: expect.any(Number) });
		} finally {
			reopened.index.release(cut);
		}
		await reopened.store.retire();
		expect(calls).toEqual([]);
		expect(await spoolFiles(root.dir), "retiring the reopened store leaves the crashed epoch alone").toEqual(left);
	} finally {
		await root.cleanup();
	}
}, 60_000);
