import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectProcessTree, reapProcessTree } from "../../../src/core/extensions/builtin/mcp/process-tree.ts";

const supportedPlatform = ["darwin", "linux"].includes(process.platform);

describe("issue #823 MCP process-tree pgrep pattern", () => {
	it.skipIf(!supportedPlatform)(
		"does not collect unrelated PIDs when pgrep requires a positional pattern",
		async () => {
			const fakeBinDir = await mkdtemp(join(tmpdir(), "senpi-issue-823-pgrep-"));
			const fakePgrepPath = join(fakeBinDir, "pgrep");
			const originalPath = process.env.PATH;
			try {
				await writeFile(
					fakePgrepPath,
					`#!/bin/sh
if [ "$3" = "." ]; then
	exit 1
fi
printf '%s\\n' 1
`,
					"utf8",
				);
				await chmod(fakePgrepPath, 0o755);
				process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;

				const collectedPids = await collectProcessTree(999_999);

				expect(collectedPids).toEqual([999_999]);
			} finally {
				if (originalPath === undefined) delete process.env.PATH;
				else process.env.PATH = originalPath;
				await rm(fakeBinDir, { recursive: true, force: true });
			}
		},
	);

	describe("killPids defense-in-depth", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("never signals PID 1 even if process discovery returns it", async () => {
			const fakeBinDir = await mkdtemp(join(tmpdir(), "senpi-issue-823-kill-"));
			const fakePgrepPath = join(fakeBinDir, "pgrep");
			const originalPath = process.env.PATH;
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
			try {
				await writeFile(
					fakePgrepPath,
					`#!/bin/sh
printf '%s\\n' 1
`,
					"utf8",
				);
				await chmod(fakePgrepPath, 0o755);
				process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;

				await reapProcessTree(999_999, { termWaitMs: 0, killWaitMs: 0 });

				const signaledPids = killSpy.mock.calls.map((call) => call[0]);
				expect(signaledPids).not.toContain(1);
			} finally {
				if (originalPath === undefined) delete process.env.PATH;
				else process.env.PATH = originalPath;
				await rm(fakeBinDir, { recursive: true, force: true });
			}
		});
	});
});
