import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as hostEnsure from "../../../src/modes/rpc/host-ensure.ts";
import { installEnsureHostSpy } from "../host-session-support.ts";

const dirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("a rig whose previous spy was never restored still reaches the real ensureHost (senpi#4890)", () => {
	test("a second spy install before cleanup delegates to the real ensureHost instead of overflowing the stack", async () => {
		// Given: the ensureHost spy installed twice, as when a rig follows a cleanup hook that timed out
		installEnsureHostSpy();
		installEnsureHostSpy();
		const root = mkdtempSync(join(tmpdir(), "rig-spy-reentry-"));
		dirs.push(root);
		const reached = new Error("reached the real ensureHost");

		// When: one ensureHost goes through the spy; the real one stops itself right after taking its lock
		const ensured = hostEnsure.ensureHost({
			socket: join(root, "r.sock"),
			agentDir: root,
			_test: {
				afterLockAcquired: () => {
					throw reached;
				},
			},
		});

		// Then: the call reached the real ensureHost, with no RangeError from a spy calling itself
		await expect(ensured).rejects.toBe(reached);
	});
});
