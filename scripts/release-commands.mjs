/**
 * The release's logging and its git and subprocess calls (moved out of `release.mjs`, senpi#6642). Every function
 * here honours `dryRun` by printing what it would run; a failed capture exits the release, a failed command throws.
 */

import { execFileSync } from "node:child_process";
import { captureOutput } from "./release-capture.mjs";

export function log(message) {
	process.stdout.write(`[release] ${message}\n`);
}

export function dryRunLog(message) {
	process.stdout.write(`[dry-run] ${message}\n`);
}

export function captureCommand(bin, args) {
	try {
		return captureOutput(bin, args);
	} catch (err) {
		const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
		process.stderr.write(`[release] error: ${bin} ${args.join(" ")} failed: ${message}\n`);
		process.exit(1);
	}
}

export function runCommand(bin, args, extraEnv) {
	try {
		execFileSync(
			bin,
			args,
			extraEnv ? { stdio: "inherit", env: { ...process.env, ...extraEnv } } : { stdio: "inherit" },
		);
	} catch (err) {
		const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
		throw new Error(`${bin} ${args.join(" ")} failed: ${message}`, { cause: err });
	}
}

export function stageChangedFiles(dryRun) {
	if (dryRun) {
		dryRunLog("git add -- <changed files>");
		return;
	}
	const output = captureCommand("git", ["ls-files", "-m", "-o", "-d", "--exclude-standard"]);
	const paths = [
		...new Set(
			output
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
	if (paths.length === 0) {
		log("no changed files to stage");
		return;
	}
	log(`git add ${paths.length} changed file(s)`);
	runCommand("git", ["add", "--", ...paths]);
}

export function gitCommit(message, dryRun) {
	if (dryRun) {
		dryRunLog(`git commit -m ${JSON.stringify(message)}`);
		return;
	}
	log(`git commit -m ${JSON.stringify(message)}`);
	runCommand("git", ["commit", "-m", message]);
}

export function gitTag(version, dryRun) {
	const tag = `v${version}`;
	if (dryRun) {
		dryRunLog(`git tag ${tag}`);
		return;
	}
	log(`git tag ${tag}`);
	runCommand("git", ["tag", tag]);
}

export function gitPush(refspec, dryRun) {
	if (dryRun) {
		dryRunLog(`git push origin ${refspec}`);
		return;
	}
	log(`git push origin ${refspec}`);
	runCommand("git", ["push", "origin", refspec]);
}
