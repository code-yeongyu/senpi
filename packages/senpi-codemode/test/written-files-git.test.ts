import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner, createNodeFsAccess } from "../src/written-files/scan-boundaries.ts";
import { WrittenFiles } from "../src/written-files/written-files.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-written-files-")));
	roots.push(root);
	return root;
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=test", ...args], { cwd });
}

function put(root: string, path: string, content: string | Uint8Array): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), content);
}

/** Runs `work` as a cell's writes against the real git and filesystem boundaries; the deadline is not under test. */
async function writtenBy(cwd: string, artifactsDir: string, work: () => void): Promise<readonly string[] | undefined> {
	const writtenFiles = new WrittenFiles({
		cwd,
		artifactsDir,
		git: createGitRunner(() => process.env),
		fs: createNodeFsAccess(),
		timeoutMs: 120_000,
	});
	const cell = writtenFiles.open({
		...fakeExtensionContext(),
		cwd,
		reportToolResult: async () => ({ toolCallId: "cell/reported-1", result: undefined, failures: [] }),
	});
	await cell.ready;
	work();
	const outcome = await cell.settle(new AbortController().signal);
	cell.close();
	return outcome?.kind === "written" ? outcome.report.files : undefined;
}

// senpi#7232: the scan reads git's own output, so this pins it against the real git and filesystem.
describe("written files against real git", () => {
	it("finds the source files a cell wrote in a repository and nothing the repository ignores", async () => {
		const root = tempRoot();
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "--quiet");
		put(repo, ".gitignore", "dist/\n");
		put(repo, "src/tracked.ts", "export const tracked = 1;\n");
		put(repo, "src/dirty before.ts", "export {};\n");
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "--message", "init");
		appendFileSync(join(repo, "src/dirty before.ts"), "// changed before the cell\n");

		const files = await writtenBy(repo, join(root, "artifacts"), () => {
			appendFileSync(join(repo, "src/tracked.ts"), "export const wrong: number = 'x';\n");
			put(repo, "src/new file.ts", "export const created = 2;\n");
			put(repo, "dist/out.js", "ignored by the repository\n");
			put(repo, "node_modules/pkg/index.js", "module.exports = 1;\n");
			put(repo, "image.bin", new Uint8Array([0, 1, 2, 3]));
			put(root, "outside.ts", "outside the workspace\n");
		});

		expect(files).toEqual(["src/new file.ts", "src/tracked.ts"]);
	});

	it("finds a file the cell wrote and committed before it finished", async () => {
		const root = tempRoot();
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "--quiet");
		put(repo, "README.md", "# repo\n");
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "--message", "init");

		const files = await writtenBy(repo, join(root, "artifacts"), () => {
			put(repo, "src/committed.ts", "export const committed = 1;\n");
			git(repo, "add", "--all");
			git(repo, "commit", "--quiet", "--message", "from the cell");
		});

		expect(files).toEqual(["src/committed.ts"]);
	});

	it("does not list a tracked path whose directory the cell replaced with a link out of the workspace", async () => {
		const root = tempRoot();
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "--quiet");
		put(repo, "lib/secret.ts", "export const tracked = 1;\n");
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "--message", "init");
		put(root, "outside/secret.ts", "export const outside = 1;\n");
		// The workspace itself is reached through a link, as a temporary directory is on macOS.
		const linked = join(root, "linked-repo");
		symlinkSync(repo, linked, "dir");

		const files = await writtenBy(linked, join(root, "artifacts"), () => {
			rmSync(join(repo, "lib"), { recursive: true });
			symlinkSync(join(root, "outside"), join(repo, "lib"), "dir");
			put(repo, "src/inside.ts", "export const inside = 1;\n");
		});

		expect(files).toEqual(["src/inside.ts"]);
	});

	it("does not list a tracked path whose directory now links into node_modules or into itself", async () => {
		const root = tempRoot();
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "--quiet");
		put(repo, "lib/aliased.ts", "export const tracked = 1;\n");
		put(repo, "loop/looped.ts", "export const tracked = 2;\n");
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "--message", "init");

		const files = await writtenBy(repo, join(root, "artifacts"), () => {
			rmSync(join(repo, "lib"), { recursive: true });
			put(repo, "node_modules/pkg/aliased.ts", "export const dependency = 1;\n");
			symlinkSync(join(repo, "node_modules", "pkg"), join(repo, "lib"), "dir");
			rmSync(join(repo, "loop"), { recursive: true });
			symlinkSync(join(repo, "loop"), join(repo, "loop"), "dir");
			put(repo, "src/inside.ts", "export const inside = 1;\n");
		});

		expect(files).toEqual(["src/inside.ts"]);
	});

	it("drops a file taken out of the index and then ignored, and still lists a tracked file restored to HEAD", async () => {
		const root = tempRoot();
		const repo = join(root, "repo");
		mkdirSync(repo);
		git(repo, "init", "--quiet");
		const committed = "export const value = 1;\n";
		put(repo, "src/restored.ts", committed);
		put(repo, "src/removed.ts", "export const removed = 1;\n");
		git(repo, "add", "--all");
		git(repo, "commit", "--quiet", "--message", "init");
		put(repo, "src/restored.ts", "export const value = 2;\n");
		git(repo, "rm", "--cached", "--quiet", "src/removed.ts");

		const files = await writtenBy(repo, join(root, "artifacts"), () => {
			appendFileSync(join(repo, ".git", "info", "exclude"), "src/removed.ts\n");
			put(repo, "src/removed.ts", "export const removed = 2;\n");
			put(repo, "src/restored.ts", committed);
		});

		expect(files).toEqual(["src/restored.ts"]);
	});

	it("honours a workspace's own ignore file where there is no repository, and leaves out the session's artifacts", async () => {
		const root = tempRoot();
		const workspace = join(root, "plain");
		put(workspace, ".gitignore", "build/\n");
		put(workspace, "src/old.py", "print('old')\n");

		const files = await writtenBy(workspace, join(workspace, "session-artifacts"), () => {
			put(workspace, "src/app.py", "print('new')\n");
			put(workspace, "session-artifacts/eval-output.log", "a cell's spilled output\n");
			put(workspace, "build/out.txt", "ignored by the workspace\n");
			put(workspace, "node_modules/pkg/index.js", "module.exports = 1;\n");
		});

		expect(files).toEqual(["src/app.py"]);
	});
});
