import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { engineBuildIdentity } from "../../../src/core/engine-build-identity.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../../../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory() {
	const dir = mkdtempSync(join(tmpdir(), "session-build-"));
	dirs.push(dir);
	return dir;
}

function readHeader(file: string | undefined) {
	if (!file) throw new Error("expected a persisted session file");
	return JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
}

it("writes the running engine identity separately from the format version in new and forked files", () => {
	const dir = directory();
	const session = SessionManager.create(dir, dir);
	const leaf = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	const source = session.getSessionFile();
	if (!source) throw new Error("missing source file");
	const fork = SessionManager.forkFrom(source, dir, dir);
	const branch = session.createBranchedSession(leaf);
	for (const file of [source, fork.getSessionFile(), branch]) {
		expect(readHeader(file)).toMatchObject({
			version: CURRENT_SESSION_VERSION,
			engineVersion: engineBuildIdentity().text,
		});
	}
});

it("does not attribute an old session to the engine that reopened it", () => {
	const dir = directory();
	const path = join(dir, "old.jsonl");
	const old = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "old",
		timestamp: "2026-01-01T00:00:00Z",
		cwd: dir,
	};
	writeFileSync(path, `${JSON.stringify(old)}\n`);
	const reopened = SessionManager.open(path, dir, dir);
	reopened.appendMessage({ role: "user", content: "continue", timestamp: 2 });
	expect(readHeader(path)).toEqual(old);
});
