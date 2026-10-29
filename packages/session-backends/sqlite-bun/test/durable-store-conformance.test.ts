// senpi#4740 (R1.b, R11.a): the STORE and KILL-STORE conformance cases on the Bun SQLite backend, through the suite
// runner, plus kills of a real process inside a durable write (SQLite crash recovery, not only the in-process cut).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildManifest,
	CONFORMANCE_REGISTRY,
	type CaseImplementation,
	type HostReport,
	KILL_STORE_CASES,
	runSuite,
	STORE_CASES,
	type StoreCaseAdapters,
} from "@earendil-works/pi-agent-core/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BunSqliteMedia, createBunSqliteMedia } from "../src/index.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const KILL_CHILD = fileURLToPath(new URL("./fixtures/kill-in-write.ts", import.meta.url));
const IMPLEMENTATIONS = new Map<string, CaseImplementation<StoreCaseAdapters>>([...STORE_CASES, ...KILL_STORE_CASES]);
const STORE_REGISTRY = CONFORMANCE_REGISTRY.filter((entry) => /^(KILL-)?STORE-/.test(entry.id));

let root: string;
let media: BunSqliteMedia;
beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "sqlite-bun-"));
	media = createBunSqliteMedia(root);
});
afterAll(async () => {
	await media.close();
	await rm(root, { recursive: true, force: true });
});

it("runs on Bun (the durable store is Bun-only)", () => {
	expect(process.versions.bun).toMatch(/^1\.(4|[5-9])\./);
});

describe("the Bun SQLite backend on the STORE and KILL-STORE cases", () => {
	let report: HostReport;
	beforeAll(async () => {
		const manifest = await buildManifest(STORE_REGISTRY, (file) => readFile(path.join(REPO_ROOT, file)));
		report = await runSuite(
			manifest,
			{ name: "bun-sqlite", provides: ["store"], adapters: { store: media } },
			IMPLEMENTATIONS,
		);
	});

	it("runs every registered store case", () => {
		expect(report.results.map((result) => result.id)).toEqual(STORE_REGISTRY.map((entry) => entry.id));
		expect(STORE_REGISTRY.length).toBeGreaterThanOrEqual(12);
	});

	for (const entry of STORE_REGISTRY) {
		it(`passes ${entry.id}`, () => {
			expect(report.results.find((result) => result.id === entry.id)).toEqual({ id: entry.id, status: "pass" });
		});
	}
});

async function seededMedium(): Promise<string> {
	const medium = await media.createMedium();
	const store = await media.open(medium);
	await store.claim(0, 1);
	await store.commit(
		1,
		[
			{ op: "append", id: "r1", kind: "entry", data: { id: "r1" } },
			{ op: "put", key: "doc", data: 1 },
		],
		() => {},
	);
	return medium;
}

function killChild(medium: string, op: string, at: string, index = -1) {
	const child = spawn(process.execPath, [KILL_CHILD, root, medium, op, at, String(index)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => void (stdout += chunk.toString()));
	return new Promise<{ signal: NodeJS.Signals | null; stdout: string }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (_code, signal) => resolve({ signal, stdout }));
	});
}

const entry = (seq: number, id: string) => ({ seq, id, kind: "entry", data: { id } });

describe("a real process killed inside a durable write", () => {
	it("killed mid-commit (after the first write is staged): nothing of the batch survives, and it commits again", async () => {
		const medium = await seededMedium();
		const before = await (await media.open(medium)).exportSnapshot();
		expect(await killChild(medium, "commit", "write", 1)).toEqual({ signal: "SIGKILL", stdout: "" });

		const restarted = await media.open(medium);
		expect(await restarted.exportSnapshot()).toEqual(before);
		expect(
			await restarted.commit(1, [{ op: "append", id: "r2", kind: "entry", data: { id: "r2" } }], () => {}),
		).toEqual({
			seqs: [2],
			head: 2,
		});
	});

	it("killed after the commit is durable (before adopt): the whole batch survives with its IDs and seqs", async () => {
		const medium = await seededMedium();
		expect(await killChild(medium, "commit", "durable")).toEqual({ signal: "SIGKILL", stdout: "" });

		expect(await (await media.open(medium)).exportSnapshot()).toEqual({
			epoch: 1,
			head: 3,
			records: [entry(1, "r1"), entry(2, "r2"), entry(3, "r3")],
			documents: [{ key: "doc", data: 2 }],
		});
	});

	it("killed after a claim is durable: the new epoch holds and the old one is fenced", async () => {
		const medium = await seededMedium();
		expect(await killChild(medium, "claim", "durable")).toEqual({ signal: "SIGKILL", stdout: "" });

		const restarted = await media.open(medium);
		expect(await restarted.readEpoch()).toBe(2);
		await expect(restarted.commit(1, [], () => {})).rejects.toMatchObject({ code: "stale-epoch" });
	});
});
