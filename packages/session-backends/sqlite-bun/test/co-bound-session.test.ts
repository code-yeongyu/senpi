import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const WRITER = join(import.meta.dirname, "fixtures", "co-bound-writer.ts");
// Both writers open the session before either appends, so a lost update drops a whole writer's entries at any count.
const PER_WRITER = 25;
// Three Bun processes and fsync'd commits: a ceiling against a hang, never a timing assumption (the writers are released
// and read back through explicit stdin/stdout signals). 5 s (vitest's default) timed out 12/12 runs on a loaded host.
const HANG_CEILING_MS = 60_000;
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Writer {
	readonly child: ChildProcessWithoutNullStreams;
	next(): Promise<{ ready?: boolean; ok?: boolean; keys?: string[] }>;
	exited: Promise<unknown>;
}

function writer(args: object): Writer {
	const child = spawn(process.execPath, [WRITER, JSON.stringify(args)], { stdio: "pipe" });
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return {
		child,
		exited: once(child, "exit"),
		async next() {
			const line = await lines.next();
			if (line.done === true) throw new Error(`writer ended without a result: ${stderr}`);
			return JSON.parse(line.value);
		},
	};
}

describe("a session on one sqlite-bun medium written by two co-bound processes (S21b-a)", () => {
	it(
		"keeps every entry both processes appended, each process's entries in its own order",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "co-bound-"));
			roots.push(root);
			const medium = join(root, "session");
			await mkdir(medium);
			const base = { root, medium, sessionId: "s-1", count: PER_WRITER };
			const first = writer({ ...base, tag: "a" });
			expect(await first.next()).toEqual({ ready: true });
			const second = writer({ ...base, tag: "b" });
			expect(await second.next()).toEqual({ ready: true });

			first.child.stdin.end("go\n");
			second.child.stdin.end("go\n");
			expect(await Promise.all([first.next(), second.next()])).toEqual([{ ok: true }, { ok: true }]);
			await Promise.all([first.exited, second.exited]);

			const reader = writer({ ...base, tag: "r", read: true });
			const keys = (await reader.next()).keys ?? [];
			await reader.exited;
			expect(keys).toHaveLength(2 * PER_WRITER);
			for (const tag of ["a", "b"]) {
				expect(keys.filter((key) => key.startsWith(`${tag}-`))).toEqual(
					Array.from({ length: PER_WRITER }, (_, index) => `${tag}-${index}`),
				);
			}
		},
		HANG_CEILING_MS,
	);
});
