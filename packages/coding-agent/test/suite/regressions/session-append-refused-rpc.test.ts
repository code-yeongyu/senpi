import { chmodSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { type RpcHermeticSession, startHermeticRpcSession } from "../../helpers/rpc-hermetic.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

let session: RpcHermeticSession | undefined;
let lockedFile: string | undefined;

afterEach(async () => {
	if (lockedFile) chmodSync(lockedFile, 0o644);
	lockedFile = undefined;
	await session?.close();
	session = undefined;
});

it("reports the writes an accepted rpc prompt lost on the event stream", async () => {
	// Given a real `--mode rpc` session whose first turn reached the session file
	session = await startHermeticRpcSession();
	const { client } = session;
	await client.start();
	await client.promptAndWait("hello one");
	const { sessionFile } = await client.getState();
	if (!sessionFile) throw new Error("test setup: rpc session has no session file");

	// When the next prompt is accepted while the file is read-only
	chmodSync(sessionFile, 0o444);
	lockedFile = sessionFile;
	const events = await client.promptAndWait("ok two");

	// Then every message the file refused arrives as a transcript_write_failed frame
	const failures = events.flatMap((event) => (event.type === "transcript_write_failed" ? [event] : []));
	expect(failures.map((failure) => failure.role)).toEqual(["user", "assistant"]);
	expect(failures.every((failure) => failure.errorMessage.includes("EACCES"))).toBe(true);
}, 90_000);
