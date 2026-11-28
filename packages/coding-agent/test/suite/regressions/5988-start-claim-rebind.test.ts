import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SESSION_HELD_EXIT_CODE } from "../../../src/cli/session-opening.ts";
import { claimSessionStart, SessionHeldError } from "../../../src/core/session-holders.ts";
import { rebindSessionFile } from "../../../src/core/session-rebind.ts";
import { encodedSessionId } from "../../../src/core/session-sidecar-store.ts";
import { dropStartClaim } from "../../../src/core/session-start-claim.ts";
import { type CliStart, cliStart } from "./5988-start-support.ts";

// senpi#5988: a start that admitted a session and then rebinds it (`--rebind`, a cross-project `--session`, the
// `--resume` picker, a moved `--continue`) keeps its start claim on the session at its new path. A start that opens the
// rebound file while the first one is still loading finds it there and is refused, instead of becoming a second writer.
let root: string;
let id: string;
let file: string;
let movedDir: string;
const started: CliStart[] = [];

async function writeSession(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(
		path,
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: new Date(0).toISOString() })}\n`,
	);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "5988-claim-rebind-"));
	id = randomUUID();
	file = join(root, "old", "shared.jsonl");
	movedDir = join(root, "moved");
	await writeSession(file);
});

afterEach(async () => {
	await dropStartClaim(id);
	for (const start of started.splice(0)) await start[Symbol.asyncDispose]();
	await rm(root, { recursive: true, force: true });
});

const claimIn = (dir: string): string => join(dir, "session-holders", encodedSessionId(id), "start.claim");

it("a start on the rebound path is refused while the rebinding start is still loading", async () => {
	expect(await claimSessionStart(file, id)).toBe(true);
	const rebound = await rebindSessionFile(file, root, movedDir);
	expect(rebound).toBe(join(movedDir, basename(file)));
	await expect(stat(claimIn(dirname(file)))).rejects.toMatchObject({ code: "ENOENT" });

	const second = cliStart({ root, file: rebound, id });
	started.push(second);
	expect(await second.next()).toBeUndefined();
	expect(await second.exited).toBe(SESSION_HELD_EXIT_CODE);
});

it("a rebind onto a path another live start has claimed is refused and keeps the session where it was", async () => {
	expect(await claimSessionStart(file, id)).toBe(true);
	const target = join(movedDir, basename(file));
	await writeSession(target);
	const other = cliStart({ root, file: target, id });
	started.push(other);
	const admitted = await other.next();
	expect(admitted).toMatchObject({ step: "admitted" });
	await rm(target);

	const refused = await rebindSessionFile(file, root, movedDir).catch((error: unknown) => error);
	expect(refused).toBeInstanceOf(SessionHeldError);
	expect(refused).toMatchObject({ holders: [{ pid: admitted?.pid }] });
	expect((await stat(file)).isFile()).toBe(true);
	expect((await stat(claimIn(dirname(file)))).isFile()).toBe(true);
});
