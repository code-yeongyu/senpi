/**
 * K9-F2 (senpi#5822): what a Node developer-hatch run (SENPI_SESSION_STORE=jsonl) writes reaches the durable store on
 * Bun, and a hatch writer racing a Bun writer either lands its entries or gets today's SessionFencedError. Runs under
 * Node; each writer is its own process (test/fixtures/hatch-peer.ts): Node children are hatch writers, Bun children bind
 * the durable default store.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sourceRuntimeArgs } from "../helpers/source-runtime-args.ts";

const PEER = fileURLToPath(new URL("../fixtures/hatch-peer.ts", import.meta.url));
type Answer = Record<string, unknown>;

function realBun(): string | undefined {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(directory, "bun");
		if (directory !== "" && existsSync(candidate)) return realpathSync(candidate);
	}
	return undefined;
}

const bun = realBun();
const children: ChildProcessWithoutNullStreams[] = [];
const roots: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-hatch-history-")));
	roots.push(root);
	const dirs = { root, agentDir: join(root, "agent"), sessionDir: join(root, "sessions") };
	mkdirSync(dirs.agentDir);
	return dirs;
}

type Dirs = ReturnType<typeof setup>;

/** A writer process: `send` answers in order; `barrier` resolves when a held rewrite reaches its file write. */
function peer(runtime: "node" | "bun", dirs: Dirs) {
	const [command, args] =
		runtime === "node" ? [process.execPath, [...sourceRuntimeArgs(), PEER]] : [bun ?? "", [PEER]];
	const child = spawn(command, args, {
		cwd: dirs.root,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: dirs.root,
			TMPDIR: process.env.TMPDIR ?? tmpdir(),
			SENPI_CODING_AGENT_DIR: dirs.agentDir,
			...(runtime === "node" ? { SENPI_SESSION_STORE: "jsonl" } : {}),
		},
		stdio: "pipe",
	});
	children.push(child);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const answers: ((answer: Answer) => void)[] = [];
	let barrier!: () => void;
	const atBarrier = new Promise<void>((resolve) => {
		barrier = resolve;
	});
	createInterface({ input: child.stdout }).on("line", (line) => {
		const value = JSON.parse(line) as Answer;
		if (value.event === "barrier") barrier();
		else answers.shift()?.(value);
	});
	const exited = once(child, "exit");
	const open = { cwd: dirs.root, sessionDir: dirs.sessionDir, agentDir: dirs.agentDir };
	return {
		send(message: Answer): Promise<Answer> {
			const answer = new Promise<Answer>((resolve, reject) => {
				answers.push(resolve);
				void exited.then(() => reject(new Error(`${runtime} peer exited: ${stderr}`)));
			});
			child.stdin.write(`${JSON.stringify({ ...open, ...message })}\n`);
			return answer;
		},
		release: () => child.stdin.write(`${JSON.stringify({ op: "release" })}\n`),
		barrier: () => atBarrier,
		async exit(): Promise<void> {
			child.stdin.end();
			await exited;
		},
	};
}

type Peer = ReturnType<typeof peer>;

async function write(peerProcess: Peer, texts: readonly string[]): Promise<void> {
	for (const text of texts) expect(await peerProcess.send({ op: "append", text })).toEqual({ ok: true });
}

async function storeSession(dirs: Dirs, texts: readonly string[]): Promise<string> {
	const creator = peer("bun", dirs);
	const file = (await creator.send({ op: "create" })).file as string;
	await write(creator, texts);
	await creator.exit();
	return file;
}

async function hatchAppend(dirs: Dirs, file: string, texts: readonly string[]): Promise<void> {
	const hatch = peer("node", dirs);
	await hatch.send({ op: "open", file });
	await write(hatch, texts);
	await hatch.exit();
}

async function stored(dirs: Dirs, file: string): Promise<Answer> {
	const reader = peer("bun", dirs);
	await reader.send({ op: "open", file });
	const result = await reader.send({ op: "stored" });
	await reader.exit();
	return result;
}

const fenced = { ok: false, code: "session_fenced" };

describe.skipIf(process.versions.bun !== undefined || bun === undefined || process.platform === "win32")(
	"the K9-F2 hatch's history on the durable store (S21b)",
	{ timeout: 180_000 },
	() => {
		it("round trip: a session the Node hatch writes lists and reopens under Bun with the same entries", async () => {
			const dirs = setup();
			const early = peer("bun", dirs);
			await early.send({ op: "create" });
			await write(early, ["t1"]);
			const hatch = peer("node", dirs);
			const file = (await hatch.send({ op: "create" })).file as string;
			await write(hatch, ["n1", "n2"]);
			await hatch.exit();

			const later = peer("bun", dirs);
			expect((await later.send({ op: "list" })).files).toContain(file);
			expect(await later.send({ op: "open", file })).toMatchObject({ entries: ["n1", "n2"] });
			expect(await later.send({ op: "stored" })).toMatchObject({ entries: ["n1", "n2"] });
			await later.exit();
			// The Bun process that had the store open before the hatch ran imports the session on its next open too.
			await early.send({ op: "open", file });
			expect(await early.send({ op: "stored" })).toMatchObject({ entries: ["n1", "n2"] });
			await early.exit();
		});

		it("append to a held session: hatch entries join the stored session in order, and later Bun writes keep them", async () => {
			const dirs = setup();
			const file = await storeSession(dirs, ["b1"]);
			await hatchAppend(dirs, file, ["n1"]);

			const second = peer("bun", dirs);
			await second.send({ op: "open", file });
			expect(await second.send({ op: "stored" })).toMatchObject({ entries: ["b1", "n1"] });
			await write(second, ["b2"]);
			await second.exit();
			await hatchAppend(dirs, file, ["n2"]);

			expect(await stored(dirs, file)).toMatchObject({ entries: ["b1", "n1", "b2", "n2"] });
		});

		it("divergence: a diverged file the hatch wrote last becomes a forked session; the stored session stays", async () => {
			const dirs = setup();
			const file = await storeSession(dirs, ["b1", "b2"]);
			const lines = readFileSync(file, "utf8").split("\n");
			writeFileSync(file, lines.filter((line) => !line.includes('"content":"b2"')).join("\n"));
			await hatchAppend(dirs, file, ["n1"]);

			const result = await stored(dirs, file);
			expect(result).toMatchObject({ entries: ["b1", "b2"], ledgerEntries: ["b1", "n1"] });
			expect(result.ledgerSessionId).not.toBe(result.id);
			expect(result.divergence).toMatchObject({ kind: "k9f2", parentSessionId: result.id });
		});

		it("two Bun processes on one session both keep writing: neither fences the other", async () => {
			const dirs = setup();
			const file = await storeSession(dirs, ["b0"]);
			const first = peer("bun", dirs);
			const second = peer("bun", dirs);
			await first.send({ op: "open", file });
			await second.send({ op: "open", file });
			await write(first, ["a1"]);
			await write(second, ["c1"]);
			await write(first, ["a2"]);
			await Promise.all([first.exit(), second.exit()]);

			expect(existsSync(`${file}.fence`)).toBe(false);
		});

		// DRIFT A: Node first, Bun's open fences the hatch writer. Bun first, the hatch's appends land and are imported,
		// until a Bun projection rewrite fences it (after importing what it wrote so far).
		it.each([
			["node", "append", fenced, fenced],
			["node", "rewrite", fenced, fenced],
			["bun", "append", { ok: true }, { ok: true }],
			["bun", "rewrite", { ok: true }, fenced],
		] as const)(
			"concurrent: %s opens first, Bun writes by %s; each hatch append lands or gets SessionFencedError",
			async (first, mode, firstAppend, secondAppend) => {
				const dirs = setup();
				const file = await storeSession(dirs, ["b0"]);
				const hatch = peer("node", dirs);
				const store = peer("bun", dirs);
				for (const opener of first === "node" ? [hatch, store] : [store, hatch])
					await opener.send({ op: "open", file });

				const appended = [await hatch.send({ op: "append", text: "n1" })];
				if (mode === "append") {
					await write(store, ["b1"]);
					appended.push(await hatch.send({ op: "append", text: "n2" }));
				} else {
					const rewrite = store.send({ op: "rewrite", text: "b1" });
					await store.barrier();
					appended.push(await hatch.send({ op: "append", text: "n2" }));
					store.release();
					expect(await rewrite).toEqual({ ok: true });
				}
				await Promise.all([hatch.exit(), store.exit()]);

				expect(appended).toEqual([firstAppend, secondAppend]);
				const entries = (await stored(dirs, file)).entries as string[];
				expect(entries).toEqual(expect.arrayContaining(["b0", "b1"]));
				const landed = ["n1", "n2"].filter((_, index) => appended[index]?.ok === true);
				expect(entries).toEqual(expect.arrayContaining(landed));
			},
		);
	},
);
