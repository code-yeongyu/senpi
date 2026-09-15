#!/usr/bin/env node
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { waitForMarker } from "./run-workspaces.test-support.mjs";

it("receives a split readiness record without filesystem notifications", async () => {
	// Given: the pipe is the notification seam; there is no filesystem watcher.
	const input = new PassThrough();
	const lines = createInterface({ input });
	const ready = waitForMarker(lines, "started", 5_000);
	try {
		// When
		input.write('package-manager output\n{"event":"started","pi');
		input.write('d":123}\n');
		// Then
		assert.deepEqual(await ready, { event: "started", pid: 123 });
	} finally {
		lines.close();
		input.destroy();
	}
});

it("rejects malformed readiness rather than accepting success-looking output", async () => {
	// Given
	const input = new PassThrough();
	const lines = createInterface({ input });
	const failed = assert.rejects(waitForMarker(lines, "started", 5_000), SyntaxError);
	try {
		// When
		input.write('{"event":invalid}\n');
		// Then
		await failed;
	} finally {
		lines.close();
		input.destroy();
	}
});

it("rejects an exited fixture that never announced readiness", async () => {
	// Given
	const input = new PassThrough();
	const lines = createInterface({ input });
	const failed = assert.rejects(waitForMarker(lines, "started", 5_000));
	try {
		// When
		input.end("PASS\n");
		// Then
		await failed;
	} finally {
		lines.close();
		input.destroy();
	}
});
