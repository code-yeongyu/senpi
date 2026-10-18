import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	holdSessionFile,
	SessionHeldError,
	SessionMovedError,
	SessionMovingError,
} from "../../../src/core/session-holders.ts";
import { getDefaultSessionDir } from "../../../src/core/session-manager.ts";
import { rebindSessionFile } from "../../../src/core/session-rebind.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";
import {
	cleanupIssue2184,
	isolateAgentDir,
	RECORDED,
	SESSION_ID,
	spawnModuleChild,
	srcUrl,
	tempDir,
	writeSession,
} from "./issue-2184-support.ts";

// Issue #2184: a rebind must not move a session another live process holds, must be atomic against a
// concurrent rebind, and a process must never keep writing to a session moved out from under it.

assertWorkspaceBuildPrerequisite(import.meta.url);

beforeEach(isolateAgentDir);
afterEach(cleanupIssue2184);

function fixture() {
	const root = tempDir();
	const oldCwd = join(root, "old", "repo");
	const newCwd = join(root, "new", "repo");
	const sessionFile = writeSession(getDefaultSessionDir(oldCwd), oldCwd, { identity: RECORDED });
	return { root, oldCwd, newCwd, sessionFile, original: readFileSync(sessionFile, "utf8") };
}

function holderChild(sessionFile: string, cwd: string) {
	return spawnModuleChild(
		[
			`const { holdSessionFile } = await import(${JSON.stringify(srcUrl("core/session-holders.ts"))});`,
			`const hold = holdSessionFile(${JSON.stringify(sessionFile)}, ${JSON.stringify(SESSION_ID)}, { cwd: ${JSON.stringify(cwd)}, expectExisting: true });`,
			'process.stdout.write("HELD\\n");',
			'process.stdin.on("data", () => { hold.release(); process.stdout.write("RELEASED\\n", () => process.exit(0)); });',
		].join("\n"),
	);
}

describe("issue #2184 cross-process session hold", () => {
	it("refuses to move a session another live process holds and names that process", async () => {
		const { oldCwd, newCwd, sessionFile, original } = fixture();
		const holder = holderChild(sessionFile, oldCwd);
		await holder.line("HELD");

		const error = await rebindSessionFile(sessionFile, newCwd).then(
			() => undefined,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(SessionHeldError);
		const held = error as SessionHeldError;
		expect(held.holders.map((h) => h.pid)).toEqual([holder.child.pid]);
		expect(held.holders[0]?.cwd).toBe(oldCwd);
		expect(held.message).toContain(String(holder.child.pid));
		expect(readFileSync(sessionFile, "utf8")).toBe(original);
		expect(existsSync(join(getDefaultSessionDir(newCwd), "session-holders"))).toBe(false);

		holder.send("release\n");
		await holder.line("RELEASED");
		const target = await rebindSessionFile(sessionFile, newCwd);
		expect(dirname(target)).toBe(getDefaultSessionDir(newCwd));
	});

	it("moves a session whose holder died without releasing it", async () => {
		const { oldCwd, newCwd, sessionFile } = fixture();
		const holder = holderChild(sessionFile, oldCwd);
		await holder.line("HELD");
		holder.child.kill("SIGKILL");
		await holder.exit();

		const target = await rebindSessionFile(sessionFile, newCwd);

		expect(existsSync(target)).toBe(true);
		expect(existsSync(sessionFile)).toBe(false);
	});

	it("counts a hold of this very process until it is released", async () => {
		const { oldCwd, newCwd, sessionFile } = fixture();
		const hold = holdSessionFile(sessionFile, SESSION_ID, { cwd: oldCwd, expectExisting: true });

		await expect(rebindSessionFile(sessionFile, newCwd)).rejects.toBeInstanceOf(SessionHeldError);
		hold.release();

		await expect(rebindSessionFile(sessionFile, newCwd)).resolves.toBe(
			join(getDefaultSessionDir(newCwd), sessionFile.split("/").pop() ?? ""),
		);
	});

	it("fails an open of a session that moved after it was read instead of writing to the old path", () => {
		const { oldCwd, sessionFile } = fixture();
		renameSync(sessionFile, `${sessionFile}.elsewhere`);

		expect(() => holdSessionFile(sessionFile, SESSION_ID, { cwd: oldCwd, expectExisting: true })).toThrow(
			SessionMovedError,
		);
		expect(() => holdSessionFile(sessionFile, SESSION_ID, { cwd: oldCwd, expectExisting: false })).not.toThrow();
	});

	it("keeps opens and other rebinds out while a move is in progress", async () => {
		const { oldCwd, newCwd, sessionFile } = fixture();
		const mover = spawnModuleChild(
			[
				`const { withSessionMoveLock } = await import(${JSON.stringify(srcUrl("core/session-holders.ts"))});`,
				`await withSessionMoveLock(${JSON.stringify(sessionFile)}, ${JSON.stringify(SESSION_ID)}, () => new Promise((resolve) => {`,
				'\tprocess.stdout.write("MOVING\\n");',
				'\tprocess.stdin.on("data", resolve);',
				"}));",
				'process.stdout.write("MOVED\\n", () => process.exit(0));',
			].join("\n"),
		);
		await mover.line("MOVING");

		expect(() => holdSessionFile(sessionFile, SESSION_ID, { cwd: oldCwd, expectExisting: true })).toThrow(
			SessionMovingError,
		);
		const busy = await rebindSessionFile(sessionFile, newCwd, undefined, { moveLockWaitMs: 0 }).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(busy).toBeInstanceOf(SessionMovingError);
		expect((busy as SessionMovingError).message).toContain(String(mover.child.pid));

		mover.send("go\n");
		await mover.line("MOVED");
		const hold = holdSessionFile(sessionFile, SESSION_ID, { cwd: oldCwd, expectExisting: true });
		hold.release();
	});

	it("lets two concurrent rebinds of one session end at the same single target", async () => {
		const { newCwd, sessionFile, original } = fixture();
		const rebinder = () =>
			spawnModuleChild(
				[
					`const { rebindSessionFile } = await import(${JSON.stringify(srcUrl("core/session-rebind.ts"))});`,
					'process.stdout.write("READY\\n");',
					"await new Promise((resolve) => process.stdin.once('data', resolve));",
					`const target = await rebindSessionFile(${JSON.stringify(sessionFile)}, ${JSON.stringify(newCwd)});`,
					'process.stdout.write("TARGET " + target + "\\n", () => process.exit(0));',
				].join("\n"),
			);
		const first = rebinder();
		const second = rebinder();
		await Promise.all([first.line("READY"), second.line("READY")]);

		first.send("go\n");
		second.send("go\n");
		const targets = await Promise.all([first.line("TARGET "), second.line("TARGET ")]);

		const expected = join(getDefaultSessionDir(newCwd), sessionFile.split("/").pop() ?? "");
		expect(targets).toEqual([`TARGET ${expected}`, `TARGET ${expected}`]);
		expect(existsSync(sessionFile)).toBe(false);
		const [header, ...rest] = readFileSync(expected, "utf8").split("\n");
		expect(JSON.parse(header ?? "{}").cwd).toBe(newCwd);
		expect(rest.join("\n")).toBe(original.slice(original.indexOf("\n") + 1));
		expect(readdirSync(dirname(expected)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
