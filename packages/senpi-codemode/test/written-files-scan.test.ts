import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSignature, GitOutcome, ScanFs } from "../src/written-files/scan-boundaries.ts";
import { SOURCE_FILE_MAX_BYTES } from "../src/written-files/source-file.ts";
import { type WorkspaceScan, WorkspaceScanner } from "../src/written-files/workspace-scan.ts";

const CWD = join("/", "repo", "pkg");
const SIGNATURE: FileSignature = { size: 10, mtimeMs: 1, ctimeMs: 1, ino: 1 };
const records = (...lines: string[]): GitOutcome => ({ kind: "ok", stdout: `${lines.join("\0")}\0` });

/** Scripts git by subcommand; every listed path is a regular file unless `sizes` says otherwise. */
function scanner(answers: Record<string, GitOutcome>, sizes: Record<string, number | undefined> = {}) {
	const calls: string[][] = [];
	const fs: ScanFs = {
		stat: async (path) => {
			const relative = path.slice(CWD.length + 1).replaceAll("\\", "/");
			if (!(relative in sizes)) return SIGNATURE;
			const size = sizes[relative];
			return size === undefined ? undefined : { ...SIGNATURE, size };
		},
		read: async () => undefined,
	};
	const subject = new WorkspaceScanner({
		cwd: CWD,
		artifactsDir: join("/", "artifacts"),
		fs,
		pathLimit: 5,
		git: async (args) => {
			calls.push([...args]);
			const subcommand = args.find((arg) => !arg.startsWith("--")) ?? "";
			return answers[subcommand] ?? { kind: "exit", code: 128 };
		},
	});
	return { subject, calls };
}

function paths(scan: WorkspaceScan): string[] | string {
	return scan.kind === "files" ? [...scan.files.keys()].sort() : scan.reason;
}

const AT_REPOSITORY_ROOT = "/repo/pkg\n\n";

// senpi#7232
describe("workspace scan", () => {
	it("reads the changed and untracked source files of a repository and leaves out what is never source", async () => {
		const { subject } = scanner(
			{
				"rev-parse": { kind: "ok", stdout: AT_REPOSITORY_ROOT },
				status: records(
					"# branch.oid 1111",
					"# branch.head main",
					"1 .M N... 100644 100644 100644 aaaa bbbb src/with space.ts",
					"2 R. N... 100644 100644 100644 aaaa bbbb R100 src/renamed.ts",
					"src/before-rename.ts",
					"u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts",
					"? src/new.ts",
					"? vendor/cloned-repository/",
					"? node_modules/pkg/index.js",
					"? tools/.git/config",
				),
			},
			{ "src/conflict.ts": SOURCE_FILE_MAX_BYTES + 1, "src/new.ts": undefined },
		);

		const scan = await subject.scan();

		expect(paths(scan)).toEqual(["src/renamed.ts", "src/with space.ts"]);
		expect(scan).toMatchObject({ head: "1111" });
	});

	it("maps repository-root paths into a workspace below the root", async () => {
		const { subject } = scanner({
			"rev-parse": { kind: "ok", stdout: "/repo\npkg/\n" },
			"check-ignore": { kind: "exit", code: 1 },
			status: records("# branch.oid 1111", "? pkg/src/a.ts", "? other/b.ts"),
		});

		expect(paths(await subject.scan())).toEqual(["src/a.ts"]);
	});

	it("keeps files committed since the scan it is compared with", async () => {
		const { subject, calls } = scanner({
			"rev-parse": { kind: "ok", stdout: AT_REPOSITORY_ROOT },
			status: records("# branch.oid 2222"),
			diff: records("src/committed.ts"),
		});

		expect(paths(await subject.scan({ head: "1111", files: new Map() }))).toEqual(["src/committed.ts"]);
		expect(calls.at(-1)).toEqual(["diff", "--name-only", "-z", "--no-renames", "1111", "2222", "--", "."]);
	});

	// Review finding: a file written back to its HEAD content leaves `git status`, so it is checked again from here.
	it("keeps the candidates of the scan it is compared with, within the same path limit", async () => {
		const answers: Record<string, GitOutcome> = {
			"rev-parse": { kind: "ok", stdout: AT_REPOSITORY_ROOT },
			status: records("# branch.oid 1111", "? src/new.ts"),
		};
		const previous = (count: number) => ({
			head: "1111",
			files: new Map(Array.from({ length: count }, (_, index) => [`src/restored-${index}.ts`, SIGNATURE] as const)),
		});

		expect(paths(await scanner(answers).subject.scan(previous(1)))).toEqual(["src/new.ts", "src/restored-0.ts"]);
		expect(paths(await scanner(answers).subject.scan(previous(5)))).toBe("over_budget");
	});

	it.each([
		["outside a repository", { "rev-parse": { kind: "exit", code: 128 } }],
		[
			"in a directory its repository ignores",
			{ "rev-parse": { kind: "ok", stdout: "/repo\npkg/\n" }, "check-ignore": { kind: "ok", stdout: "" } },
		],
	] satisfies Array<[string, Record<string, GitOutcome>]>)(
		"lists a workspace %s under its own ignore files",
		async (_name, located) => {
			const { subject, calls } = scanner({
				...located,
				init: { kind: "ok", stdout: "" },
				"ls-files": records("src/app.py", ".gitignore"),
			});

			expect(paths(await subject.scan())).toEqual([".gitignore", "src/app.py"]);
			expect(calls.at(-1)).toEqual([
				`--git-dir=${join("/", "artifacts", "written-files-scan", ".git")}`,
				`--work-tree=${CWD}`,
				"ls-files",
				"-z",
				"--others",
				"--exclude-standard",
				"--exclude=.git/",
				"--exclude=node_modules/",
			]);
		},
	);

	it.each([
		["git is not installed", { "rev-parse": { kind: "unavailable" } }, "git_unavailable"],
		[
			"git runs past its deadline",
			{ "rev-parse": { kind: "ok", stdout: AT_REPOSITORY_ROOT }, status: { kind: "over_budget" } },
			"over_budget",
		],
		[
			"git fails",
			{ "rev-parse": { kind: "ok", stdout: AT_REPOSITORY_ROOT }, status: { kind: "exit", code: 128 } },
			"scan_failed",
		],
		[
			"more paths changed than a scan may stat",
			{
				"rev-parse": { kind: "ok", stdout: AT_REPOSITORY_ROOT },
				status: records("? a.ts", "? b.ts", "? c.ts", "? d.ts", "? e.ts", "? f.ts"),
			},
			"over_budget",
		],
	] satisfies Array<[string, Record<string, GitOutcome>, string]>)(
		"is abandoned when %s",
		async (_name, answers, reason) => {
			expect(paths(await scanner(answers).subject.scan())).toBe(reason);
		},
	);
});
