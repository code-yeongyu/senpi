import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Real CLI resolution inventory. The caller owns the snapshot and temporary state. */
export function inventoryRuntime(snapshot: string, state: string, runtime: string): readonly string[] {
	mkdirSync(join(state, "home"), { recursive: true });
	const bin = join(state, "bin");
	mkdirSync(bin, { recursive: true });
	// Keep the two interpreters available without exposing an ambient newer `claude` on PATH.
	// POSIX links retain a shared-library Node install's rpaths. Windows needs no symlink privilege.
	for (const name of ["node", "bun"]) {
		const executable = spawnSync(name, ["-e", "console.log(process.execPath)"], {
			cwd: state,
			encoding: "utf8",
			timeout: 30_000,
			env: { PATH: process.env.PATH ?? "", HOME: join(state, "home"), TMPDIR: state },
		});
		assert.equal(executable.status, 0, executable.stderr);
		const source = executable.stdout.trim();
		const target = join(bin, process.platform === "win32" ? `${name}.exe` : name);
		if (process.platform === "win32") copyFileSync(source, target, constants.COPYFILE_FICLONE);
		else symlinkSync(source, target);
	}
	writeFileSync(join(state, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: ["codemode"] }));
	const extension = join(state, "inventory-extension.ts");
	copyFileSync(join(here, "inventory-extension.ts"), extension);
	const log = join(state, "modules.jsonl");
	const receipt = join(state, "receipt.json");
	writeFileSync(log, "");
	const env = {
		PATH: [bin, ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(delimiter),
		HOME: join(state, "home"),
		TMPDIR: state,
		SENPI_CODING_AGENT_DIR: state,
		PI_OFFLINE: "1",
		SENPI_INVENTORY_LOG: log,
		SENPI_INVENTORY_RECEIPT: receipt,
	};
	const preload = join(here, "inventory-preload.mjs");
	const cli = join(snapshot, "dist/bundle/cli.js");
	const scenarios = [
		["--help"],
		["--extension", extension, "--help"],
		["--extension", extension, "--provider", "faux", "--model", "faux-1", "-p", "inventory"],
		["--extension", extension, "--provider", "faux", "--model", "faux-1", "-p", "bootstrap"],
	];
	for (const args of scenarios) {
		const evalProbe = args.includes("bootstrap");
		if (evalProbe) writeFileSync(join(state, "settings.json"), "{}");
		rmSync(`${receipt}.turn`, { force: true });
		const result = spawnSync(runtime, ["--import", preload, cli, ...args], {
			cwd: state,
			env: { ...env, ...(evalProbe ? { SENPI_INVENTORY_EVAL: "1" } : {}) },
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
		});
		assert.equal(result.status, 0, `${runtime} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
		if (args.includes("--extension") && args.includes("--help"))
			assert(result.stdout.includes("--snapshot-inventory"), `${result.stdout}\n${result.stderr}`);
		if (args.includes("-p")) {
			assert(result.stdout.includes("SNAPSHOT_INVENTORY_TURN"), result.stderr);
			const turn: unknown = JSON.parse(readFileSync(`${receipt}.turn`, "utf8"));
			assert.deepEqual(turn, { calls: evalProbe ? 2 : 1 });
		}
		if (evalProbe)
			assert(existsSync(`${receipt}.eval`), `${runtime}: eval bootstrap was not delivered\n${result.stderr}`);
	}
	const paths = [
		...new Set(
			readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const path: unknown = JSON.parse(line);
					assert.equal(typeof path, "string");
					return String(path);
				}),
		),
	].sort();
	assert(paths.length > 0, "resolver instrumentation must observe runtime modules");
	for (const path of paths) {
		const inside = relative(snapshot, path);
		assert(!isAbsolute(inside) && !inside.startsWith(".."), `runtime escaped its snapshot: ${path}`);
	}
	return paths;
}
