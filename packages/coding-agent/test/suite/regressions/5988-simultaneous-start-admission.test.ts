import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SESSION_HELD_EXIT_CODE } from "../../../src/cli/session-opening.ts";
import { type CliStart, cliStart } from "./5988-start-support.ts";

// senpi#5988: startup admission checks for a live holder, and the starting process publishes its own holder record
// only later. Two `--session <file>` starts that both run the check before either publishes must not both become
// writers: exactly one is admitted, and the other gets the held-session refusal.
let root: string;
let file: string;
let id: string;
const started: CliStart[] = [];

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
	for (const start of started.splice(0)) await start[Symbol.asyncDispose]();
	await rm(root, { recursive: true, force: true });
});

function start(): CliStart {
	const one = cliStart({ root, file, id });
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
