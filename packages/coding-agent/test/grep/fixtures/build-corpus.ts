import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MiB = 1024 * 1024;

export async function buildCorpus(
	options: { git?: boolean } = {},
): Promise<{ root: string; cleanup(): Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "grep-corpus-"));
	const put = async (relative: string, data: string | Buffer) => {
		const path = join(root, relative);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, data);
	};
	await put(".gitignore", "ignored/\n");
	await put(".ignore", "scratch/\n");
	await put("src/a.ts", "needle one\r\nnope\r\nneedle two\r\nneedle three\r\n");
	await put("src/z.ts", "nothing\nneedle\n");
	const deep = Array.from({ length: 40 }, (_, i) => (i === 4 || i === 39 ? "needle" : `line ${i + 1}`));
	await put("src/nested/deep/b.ts", `${deep.join("\n")}\n`);
	await put(".hidden/h.ts", "needle\n");
	await put("ignored/i.ts", "needle\n");
	await put("scratch/s.ts", "needle\n");
	await put("bin.dat", Buffer.concat([Buffer.from("needle\n"), Buffer.from([0]), Buffer.from("needle\n")]));
	await put(
		"late-nul.bin",
		Buffer.concat([Buffer.from("needle\n"), Buffer.alloc(70000, "a"), Buffer.from("\n\0\nneedle\n")]),
	);
	// Keep both matches at their frozen offsets, with a complete line in the inspected prefix.
	const big = Buffer.alloc(5 * MiB, 97);
	Buffer.from("needle\n").copy(big, 100);
	Buffer.from("needle\n").copy(big, 4 * MiB + 100);
	await put("big.txt", big);
	const late = Buffer.alloc(5 * MiB, 97);
	Buffer.from("needle\n").copy(late, 100);
	late[4500000] = 0;
	await put("big-late-nul.txt", late);
	await put("unicode.ts", `${"界".repeat(600)}needle\n`);
	await put("braces.ts", "foo{bar}\n");
	await put("lookaround.ts", "pre-needle\n");
	await put("latin1.txt", Buffer.concat([Buffer.from([0xe9]), Buffer.from(" needle\n")]));
	await symlink(".", join(root, "loop"));
	if (options.git !== false) {
		await execFileAsync("git", ["init", "-q"], { cwd: root });
		await execFileAsync("git", ["add", "-A"], { cwd: root });
		// CI runners carry no git identity, and a developer machine may force commit signing or
		// point core.hooksPath at hooks this throwaway repo must not run; the fixture commit only
		// exists to make .gitignore semantics real. Identity env vars outrank `-c user.*`, so set
		// them here rather than relying on the ambient config.
		const env = {
			...process.env,
			GIT_AUTHOR_NAME: "grep corpus",
			GIT_AUTHOR_EMAIL: "corpus@example.invalid",
			GIT_COMMITTER_NAME: "grep corpus",
			GIT_COMMITTER_EMAIL: "corpus@example.invalid",
		};
		const isolate = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
		await execFileAsync("git", [...isolate, "commit", "-qm", "corpus"], { cwd: root, env });
	}
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
