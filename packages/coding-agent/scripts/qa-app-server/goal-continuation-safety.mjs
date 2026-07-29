#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_ENV = "SENPI_QA_PROBE_ISOLATED";
const launcherFile = fileURLToPath(import.meta.url);

if (process.argv[1] !== undefined && resolve(process.argv[1]) === launcherFile) {
	process.exitCode = runLauncher().exitCode;
}

export function runLauncher(options = {}) {
	const {
		argv = process.argv.slice(2),
		environment = process.env,
		platformName = platform(),
		sandboxExecPath = "/usr/bin/sandbox-exec",
		exists = existsSync,
		getHomeDirectory = homedir,
		getTempDirectory = tmpdir,
		makeUuid = randomUUID,
		realpath = realpathSync,
		write = writeFileSync,
		remove = rmSync,
		spawn = spawnSync,
		nodePath = process.execPath,
		report = (message) => console.error(message),
		launcherPath = launcherFile,
	} = options;

	let tempProbeFile;
	let exitCode = 0;
	let cleanupError;
	try {
		if (platformName !== "darwin") throw new Error("Seatbelt isolation only supported on macOS");
		if (!exists(sandboxExecPath)) throw new Error(`${sandboxExecPath} not found`);

		const realAgentDir = join(getHomeDirectory(), ".senpi", "agent");
		const lexicalAgentPath = realAgentDir;
		let realpathAgentPath = realAgentDir;
		try {
			realpathAgentPath = realpath(realAgentDir);
		} catch {
			// Path may not exist yet; use lexical version.
		}

		const pathHash = createHash("sha256")
			.update(JSON.stringify({ lexical: lexicalAgentPath, realpath: realpathAgentPath }))
			.digest("hex");

		tempProbeFile = join(getTempDirectory(), `senpi-qa-probe-write-test-${makeUuid()}.txt`);
		write(tempProbeFile, "probe write test");
		let realpathProbeFile = tempProbeFile;
		try {
			realpathProbeFile = realpath(tempProbeFile);
		} catch {
			// Use lexical version if realpath fails.
		}

		const profile = buildProfile(lexicalAgentPath, realpathAgentPath, tempProbeFile, realpathProbeFile);
		const profileHash = createHash("sha256").update(profile).digest("hex");
		const probeScript = join(launcherPath, "..", "goal-continuation-safety-probe.mjs");
		const probeArgs = [
			"--marker",
			`probe-${makeUuid()}`,
			"--profile-hash",
			profileHash,
			"--path-hash",
			pathHash,
			"--probe-file",
			tempProbeFile,
			...argv,
		];
		const markerValue = probeArgs[1];
		environment[MARKER_ENV] = markerValue;

		const result = spawn(sandboxExecPath, ["-p", profile, nodePath, probeScript, ...probeArgs], { stdio: "inherit" });
		if (result.error) throw new Error(`Probe launch failed: ${result.error.message}`);
		if (result.signal) throw new Error(`Probe killed by signal ${result.signal}`);
		exitCode = result.status ?? 0;
	} catch (error) {
		report(`LAUNCHER ERROR: ${errorMessage(error)}`);
		exitCode = 1;
	} finally {
		if (tempProbeFile !== undefined) {
			try {
				remove(tempProbeFile, { force: true });
			} catch (error) {
				cleanupError = error;
				report(`LAUNCHER CLEANUP ERROR: failed to remove ${tempProbeFile}: ${errorMessage(error)}`);
				exitCode = 1;
			}
		}
	}
	return { exitCode, tempProbeFile, cleanupError };
}

export function buildProfile(lexicalPath, realpathPath, lexicalProbeFile, realpathProbeFile) {
	const escapeSeatbeltString = (str) => str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const denies = [
		`(deny file-read* (subpath "${escapeSeatbeltString(lexicalPath)}"))`,
		`(deny file-write* (subpath "${escapeSeatbeltString(lexicalPath)}"))`,
	];
	if (realpathPath !== lexicalPath) {
		denies.push(`(deny file-read* (subpath "${escapeSeatbeltString(realpathPath)}"))`);
		denies.push(`(deny file-write* (subpath "${escapeSeatbeltString(realpathPath)}"))`);
	}
	denies.push(`(deny file-write* (path "${escapeSeatbeltString(lexicalProbeFile)}"))`);
	if (realpathProbeFile !== lexicalProbeFile) {
		denies.push(`(deny file-write* (path "${escapeSeatbeltString(realpathProbeFile)}"))`);
	}
	return `(version 1)
(allow default)
${denies.join("\n")}`;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
