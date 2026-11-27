import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SESSION_HELD_EXIT_CODE } from "../../../src/cli/session-opening.ts";

// senpi#5988: startup admission checks for a live holder, and the starting process publishes its own holder record
// only later. Two `--session <file>` starts that both run the check before either publishes must not both become
// writers: exactly one is admitted, and the other gets the held-session refusal.
const STEP = fileURLToPath(new URL("./5988-start-step.ts", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));

let root: string;
let file: string;
let id: string;
const started: Start[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "5988-simultaneous-start-"));
	id = randomUUID();
	file = join(root, "shared.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});

afterEach(async () => {
	for (const start of started.splice(0)) {
		start.child.stdin.end();
		await start.exited;
	}
	await rm(root, { recursive: true, force: true });
});

interface Start {
	readonly child: ChildProcessWithoutNullStreams;
	readonly exited: Promise<number | null>;
	next(): Promise<Record<string, unknown> | undefined>;
	go(): void;
}

function start(): Start {
	const child = spawn("bun", [STEP, JSON.stringify({ root, file, id })], {
		cwd: REPO,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const one: Start = {
		child,
		exited,
		next: async () => {
			const line = await lines.next();
			if (line.done === true) return undefined;
			const value: unknown = JSON.parse(line.value);
			return typeof value === "object" && value !== null ? { ...value } : undefined;
		},
		go: () => void child.stdin.write("go\n"),
	};
	started.push(one);
	return one;
}

it("control: a start that finds the first start's holder record is refused", async () => {
	const first = start();
	expect(await first.next()).toMatchObject({ step: "admitted" });
	first.go();
	expect(await first.next()).toMatchObject({ step: "holding" });

	const second = start();
	expect(await second.next()).toBeUndefined();
	expect(await second.exited).toBe(SESSION_HELD_EXIT_CODE);
});

it("admits exactly one of two starts that both run admission before either publishes its holder", async () => {
	const first = start();
	const second = start();
	const admitted = [await first.next(), await second.next()].filter((line) => line?.step === "admitted");
	for (const one of [first, second]) one.go();
	const holding = [await first.next(), await second.next()].filter((line) => line?.step === "holding");
	for (const one of [first, second]) one.go();
	const sees = [await first.next(), await second.next()];

	expect.soft(admitted).toHaveLength(1);
	expect.soft(holding).toHaveLength(1);
	expect.soft(sees.flatMap((line) => (Array.isArray(line?.others) ? line.others : []))).toEqual([]);
});
