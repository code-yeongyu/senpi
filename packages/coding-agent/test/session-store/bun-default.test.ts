import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";

const WRITER = join(import.meta.dirname, "..", "fixtures", "default-store-writer.ts");
const BUN = process.env.SENPI_TEST_BUN ?? "bun";
const PER_WRITER = 25;
// Child Bun processes and fsync'd commits: a hang ceiling only; every wait below is an explicit stdin/stdout signal.
const HANG_CEILING_MS = 60_000;

let agentDir: string;
beforeEach(() => {
	agentDir = makeTempDir(join(tmpdir(), "s21b1-store-"));
});

type Action = "append" | "hold-then-append" | "takeover-then-append" | "crash-at-claim" | "read";
interface Result {
	readonly ok?: boolean;
	readonly epoch?: number;
	readonly code?: string;
	readonly ready?: boolean;
	readonly keys?: readonly string[];
}

interface Writer {
	readonly child: ChildProcessWithoutNullStreams;
	next(): Promise<Result>;
	exit(): Promise<number | null>;
	stderr(): string;
}

function start(sessionId: string, action: Action, extra: { count?: number; tag?: string } = {}): Writer {
	const child = spawn(BUN, [WRITER, JSON.stringify({ agentDir, sessionId, action, ...extra })], { stdio: "pipe" });
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	// "close", not "exit": stdout and stderr are fully read by then.
	const exited = once(child, "close").then(([code]) => code as number | null);
	return {
		child,
		async next() {
			const line = await lines.next();
			if (line.done === true) throw new Error(`writer ended without a result (exit ${await exited}): ${stderr}`);
			return JSON.parse(line.value) as Result;
		},
		exit: () => exited,
		stderr: () => stderr,
	};
}

async function run(sessionId: string, action: Action, extra: { count?: number; tag?: string } = {}): Promise<Result> {
	const writer = start(sessionId, action, extra);
	const result = await writer.next();
	await writer.exit();
	return result;
}

const release = (writer: Writer): void => {
	writer.child.stdin.end("go\n");
};

describe(
	"the default durable session store on Bun (S21b b1): one medium and one epoch per session",
	{ timeout: HANG_CEILING_MS },
	() => {
		it("(a) two co-bound processes write one session concurrently and sqlite serializes every transaction", async () => {
			const results = await Promise.all([
				run("s-a", "append", { count: PER_WRITER, tag: "a" }),
				run("s-a", "append", { count: PER_WRITER, tag: "b" }),
			]);

			expect(results.map((result) => result.ok)).toEqual([true, true]);
			const keys = (await run("s-a", "read")).keys ?? [];
			expect(keys).toHaveLength(2 * PER_WRITER);
			for (const tag of ["a", "b"]) {
				expect(keys.filter((key) => key.startsWith(`${tag}-`))).toEqual(
					Array.from({ length: PER_WRITER }, (_, index) => `${tag}-${index}`),
				);
			}
		});

		it("(a) two fresh processes racing the first claim both bind at epoch 1", async () => {
			const results = await Promise.all([
				run("s-race", "append", { tag: "x" }),
				run("s-race", "append", { tag: "y" }),
			]);

			expect(results).toEqual([
				{ ok: true, epoch: 1 },
				{ ok: true, epoch: 1 },
			]);
		});

		it("(b) a takeover fences every process still bound at the old epoch: the stale peer's next write is refused", async () => {
			const peer = start("s-b", "hold-then-append", { tag: "stale" });
			expect(await peer.next()).toEqual({ ready: true, epoch: 1 });

			expect(await run("s-b", "takeover-then-append", { tag: "owner" })).toEqual({ ok: true, epoch: 2 });
			release(peer);

			expect(await peer.next()).toMatchObject({ ok: false, epoch: 1, code: "stale-epoch" });
			expect((await run("s-b", "read")).keys).toEqual(["owner-0"]);
		});

		it("(b) a takeover on one session leaves a writer bound to another session unfenced", async () => {
			const other = start("s-c", "hold-then-append", { tag: "c" });
			expect(await other.next()).toEqual({ ready: true, epoch: 1 });
			expect(await run("s-a2", "append", { tag: "a" })).toEqual({ ok: true, epoch: 1 });

			expect(await run("s-a2", "takeover-then-append", { tag: "a2" })).toEqual({ ok: true, epoch: 2 });
			release(other);

			expect(await other.next()).toEqual({ ok: true, epoch: 1 });
		});

		it("(c) a process that dies mid-claim leaves the medium claimable", async () => {
			const crashed = start("s-crash", "crash-at-claim");
			expect(await crashed.exit()).toBe(70);

			expect(await run("s-crash", "append", { tag: "after" })).toEqual({ ok: true, epoch: 1 });
			expect((await run("s-crash", "read")).keys).toEqual(["after-0"]);
		});

		it("refuses a session id that is not a single path segment", async () => {
			const writer = start("../escape", "append");
			expect(await writer.exit()).not.toBe(0);
			expect(writer.stderr()).toContain("not a session id");
		});
	},
);

// #5822 acceptance: the durable store is the default session store on Bun (createAgentSession binds it), the
// SENPI_SESSION_STORE variable is ignored on Bun, the test-only option keeps JSONL, and a hand-edited JSONL with no hatch
// marker reopens as the edited file (adopted, no fork).
describe("createAgentSession's default session store on Bun (S21b b1b)", { timeout: HANG_CEILING_MS }, () => {
	const BINDING = join(import.meta.dirname, "..", "fixtures", "default-binding-step.ts");
	const step = async (action: string, env: NodeJS.ProcessEnv = {}) => {
		const child = spawn(BUN, [BINDING, JSON.stringify({ root: agentDir, action })], {
			stdio: "pipe",
			env: { ...process.env, ...env },
		});
		const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const line = await lines.next();
		await once(child, "exit");
		if (line.done === true) throw new Error(`binding step ended without a result: ${stderr}`);
		return JSON.parse(line.value) as { keys: string[]; first: string; second: string; sameId?: boolean };
	};

	it("binds the durable store by default: every entry, before and after the bind, is in the store", async () => {
		const result = await step("wire");
		expect(result.keys).toEqual(expect.arrayContaining([result.first, result.second]));
	});

	it("reuses one store connection per session when a process binds the same session again", async () => {
		const result = (await step("rebind")) as unknown as { same: boolean; distinct: boolean; epochs: number[] };
		expect(result).toEqual({ same: true, distinct: true, epochs: [1, 1] });
	});

	// #5991 review: the store was keyed by session id alone, so a second project binding the same id replaced the first's.
	it("keeps two projects' sessions with the same id in separate stores", async () => {
		const { written, stored } = (await step("two-projects")) as unknown as {
			written: Record<"a" | "b", string>;
			stored: Record<"a" | "b", string[]>;
		};
		expect(stored.a).toContain(written.a);
		expect(stored.a).not.toContain(written.b);
		expect(stored.b).toContain(written.b);
		expect(stored.b).not.toContain(written.a);
	});

	// Nothing reads the variable on Bun today; this guards against a future reader that would let it switch stores.
	it("ignores SENPI_SESSION_STORE=jsonl on Bun", async () => {
		const result = await step("wire", { SENPI_SESSION_STORE: "jsonl" });
		expect(result.keys).toEqual(expect.arrayContaining([result.first, result.second]));
	});

	it("keeps the legacy JSONL store only through the test-only in-process option", async () => {
		expect((await step("jsonl")).keys).toEqual([]);
	});

	it("reopens a hand-edited JSONL with no hatch marker as the edited file, in the same session", async () => {
		const result = await step("edited");
		expect(result.sameId).toBe(true);
		expect(result.keys).toContain(result.first);
		expect(result.keys).not.toContain(result.second);
	});
});
