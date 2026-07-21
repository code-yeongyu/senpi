import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { StdioClient } from "./task8-thread-search-support.ts";

test("StdioClient.close kills the whole process group and resolves only after close", {
	skip: process.platform === "win32",
	timeout: 30_000,
}, async () => {
	// Given: a detached, SIGTERM-ignoring shell with a background child in the same group.
	const child = spawn("sh", ["-c", "trap '' TERM; sleep 60 & wait"], {
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const processGroupId = child.pid;
	assert.ok(processGroupId !== undefined, "shell did not expose a PID");
	const client = new StdioClient(child);

	// When: close() has to escalate past stdin EOF (the shell ignores SIGTERM/EOF).
	await client.close();

	// Then: close() returned only after the entire group (leader + background sleep) is gone.
	assert.throws(
		() => process.kill(-processGroupId, 0),
		(error: unknown) =>
			error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH",
		`close() returned with process group ${processGroupId} still alive`,
	);
});
