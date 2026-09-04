import { execFile, spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";
let branchResolutionDelivered: (() => void) | null = null;
let tablesListPoll: ((current: unknown, previous: unknown) => void) | null = null;

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		watchFile: vi.fn((_path: string, _options: unknown, listener: (current: unknown, previous: unknown) => void) => {
			tablesListPoll = listener;
		}),
		unwatchFile: vi.fn(),
	};
});

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (args[1] === "symbolic-ref") {
				queueMicrotask(() => {
					callback(resolvedBranch ? null : new Error("detached"), resolvedBranch ? `${resolvedBranch}\n` : "", "");
					queueMicrotask(() => branchResolutionDelivered?.());
				});
				return;
			}
			queueMicrotask(() => callback(new Error("unsupported"), "", ""));
		},
	),
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[1] === "symbolic-ref") {
			return { status: resolvedBranch ? 0 : 1, stdout: resolvedBranch ? `${resolvedBranch}\n` : "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

/**
 * Every `fs.watch` registration fails, mirroring an environment where watchers
 * are unavailable or exhausted (descriptor limits, unsupported filesystem).
 * The real helper invokes `onError` and returns null in exactly this shape.
 */
vi.mock("../src/utils/fs-watch.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/fs-watch.ts")>();
	return {
		...actual,
		watchWithErrorHandler: vi.fn((_path: string, _listener: unknown, onError: () => void) => {
			onError();
			return null;
		}),
	};
});

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

function createReftableWorktree(tempDir: string): { worktreeDir: string; reftableDir: string } {
	const commonGitDir = join(tempDir, "repo", ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

describe("FooterDataProvider reftable detection without usable fs.watch", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-watch-fallback-"));
		resolvedBranch = "main";
		branchResolutionDelivered = null;
		tablesListPoll = null;
		vi.useFakeTimers();
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		vi.useRealTimers();
	});

	it("still refreshes the branch through the polling fallback", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			resolvedBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			const resolutionDelivered = new Promise<void>((resolve) => {
				branchResolutionDelivered = resolve;
			});
			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			expect(tablesListPoll).not.toBeNull();
			tablesListPoll?.(
				{ mtimeMs: 1, ctimeMs: 1, size: 2 },
				{ mtimeMs: 1, ctimeMs: 1, size: 2 },
			);
			await vi.advanceTimersByTimeAsync(500);
			await resolutionDelivered;

			expect(provider.getGitBranch()).toBe("foo");
			expect(onBranchChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	}, 30_000);
});
