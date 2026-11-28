import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { admitStartupSession } from "../../../src/cli/session-opening.ts";
import { liveSessionHolders } from "../../../src/core/session-holders.ts";
import { dropStartClaim } from "../../../src/core/session-start-claim.ts";
import { type CliStart, cliStart } from "./5988-start-support.ts";

// senpi#5988: a failed holder lookup keeps startup advisory (senpi#5756) only while no live holder is confirmed. When
// this start's claim already failed because another live start holds it, a lookup that then errors must not open the
// session: under load that let both of two simultaneous starts through admission.
let root: string;
let file: string;
let id: string;
const started: CliStart[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "5988-claim-lookup-"));
	id = randomUUID();
	file = join(root, "shared.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
});

afterEach(async () => {
	await dropStartClaim(id);
	for (const start of started.splice(0)) await start[Symbol.asyncDispose]();
	await rm(root, { recursive: true, force: true });
});

const lookupFails = async () => ({ lookupFailed: true as const });

it("refuses a start whose claim a live start holds when the holder lookup then fails", async () => {
	const first = cliStart({ root, file, id });
	started.push(first);
	const admitted = await first.next();
	expect(admitted).toMatchObject({ step: "admitted" });
	const errors: string[] = [];

	const result = await admitStartupSession(file, {
		canAsk: false,
		confirm: async () => false,
		err: (line) => errors.push(line),
		lookup: lookupFails,
	});

	expect(result).toBe("refused");
	expect(errors.join("\n")).toContain("Not opened");
	expect((await liveSessionHolders(file, id)).map(({ pid }) => pid)).toEqual([admitted?.pid]);
});

it("keeps a failed lookup advisory for a start that holds the claim itself", async () => {
	const errors: string[] = [];

	const result = await admitStartupSession(file, {
		canAsk: false,
		confirm: async () => false,
		err: (line) => errors.push(line),
		lookup: lookupFails,
	});

	expect(result).toBe("open");
	expect((await liveSessionHolders(file, id)).map(({ pid }) => pid)).toEqual([process.pid]);
});
