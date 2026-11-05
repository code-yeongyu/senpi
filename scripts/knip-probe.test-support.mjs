import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Shared by the knip probe tests (senpi#4421): a temp copy of the repository, probe exports, and one knip run.

// macOS tmpdir() and /tmp are symlinks into /private, and knip reports paths relative to the real directory, so a
// probe copy must be used only through its real path or knip's report misses the probes.
export function realTempDir(prefix) {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

// Copies the working tree (tracked plus untracked, not ignored) into `target` and links each package's node_modules.
// Returns the copied paths.
export function copyRepo(repo, target) {
	const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, maxBuffer: 64 << 20 })
		.toString("utf8")
		.split("\0")
		.filter((file) => file && existsSync(join(repo, file)));
	for (const file of files) {
		mkdirSync(dirname(join(target, file)), { recursive: true });
		cpSync(join(repo, file), join(target, file), { verbatimSymlinks: true });
	}
	for (const manifest of files.filter((file) => file === "package.json" || file.endsWith("/package.json"))) {
		const dir = dirname(manifest);
		if (existsSync(join(repo, dir, "node_modules")) && !existsSync(join(target, dir, "node_modules"))) {
			symlinkSync(join(repo, dir, "node_modules"), join(target, dir, "node_modules"), "dir");
		}
	}
	return files;
}

// Appends `export const <prefix><n> = 1;` to each regular file (never through a symlink, which could point back into the
// repository) and returns the probes written.
export function appendProbes(dir, files, prefix) {
	return files
		.filter((file) => lstatSync(join(dir, file)).isFile())
		.map((file, n) => {
			const name = `${prefix}${n}`;
			appendFileSync(join(dir, file), `\nexport const ${name} = 1;\n`);
			return { file, name };
		});
}

// Runs the repository's knip in `cwd` with that directory's knip.jsonc untouched (the config CI runs) and returns every
// reported unused export as "file#name".
export function knipUnusedExports(repo, cwd) {
	const knip = spawnSync(process.execPath, [join(repo, "node_modules/knip/bin/knip.js"), "--reporter", "json", "--no-progress"], {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 << 20,
	});
	if (knip.stdout.trim() === "") throw new Error(`knip printed no report (status ${knip.status}): ${knip.stderr}`);
	return new Set(JSON.parse(knip.stdout).issues.flatMap((issue) => issue.exports.map((e) => `${issue.file}#${e.name}`)));
}
