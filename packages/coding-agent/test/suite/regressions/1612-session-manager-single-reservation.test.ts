// Regression for senpi issue #1612: opening an explicit session file allocated a second,
// phantom session path whose host grant was taken and then discarded, burning the shared
// host's per-worker reservation budget. The installer is process-wide, so this contract
// owns its own test file.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { installSessionWriteReservation } from "../../../src/core/session-write-reservation.ts";

const reserved: string[] = [];
installSessionWriteReservation((path) => {
	reserved.push(path);
});

const scratch = await realpath(await mkdtemp(join(tmpdir(), "senpi-1612-session-manager-")));

beforeEach(() => {
	reserved.length = 0;
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

it("reserves only the explicit path when the session file does not exist yet", () => {
	// Given: an absolute session path with nothing on disk.
	const sessionFile = join(scratch, "fresh.jsonl");

	// When: the manager opens it the way --session and open_session do.
	SessionManager.open(sessionFile);

	// Then: no second session path was ever granted.
	expect([...new Set(reserved)]).toEqual([sessionFile]);
});

it("reserves only the explicit path when the session file is empty", async () => {
	// Given: an existing zero-byte session file.
	const sessionFile = join(scratch, "empty.jsonl");
	await writeFile(sessionFile, "");

	// When: the manager opens it and initializes the header in place.
	const manager = SessionManager.open(sessionFile);

	// Then: the initialized session writes to the explicit path only.
	expect([...new Set(reserved)]).toEqual([sessionFile]);
	expect(manager.getSessionFile()).toBe(sessionFile);
});
