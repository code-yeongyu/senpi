// BETA(omo-local-update): removable beta module - delete together with
// omo-local-update.ts and all test/omo-local-update* files.
//
// Detached background worker spawn for the OMO local plugin update. The
// foreground `senpi update` only fetches and compares; when a rebuild is
// needed it re-invokes this CLI as `update --omo-local-update-worker`
// (daemon.ts spawn pattern: detached, unref, output to a log file) so the
// 30s+ bun install/build never blocks the user's terminal. The worker
// serializes against concurrent updates through the existing pid lock.

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectInstallMethod } from "../config.ts";

export interface OmoLocalWorkerSpawnRequest {
	agentDir: string;
	force: boolean;
}

export type OmoLocalWorkerSpawnOutcome =
	| { ok: true; pid: number | undefined; logPath: string }
	| { ok: false; message: string };

export type OmoLocalSpawnWorker = (request: OmoLocalWorkerSpawnRequest) => OmoLocalWorkerSpawnOutcome;

export function omoLocalUpdateWorkerLogPath(agentDir: string): string {
	return join(agentDir, "omo-local-update", "worker.log");
}

function workerCommandArgs(force: boolean): string[] {
	const updateArgs = ["update", "--omo-local-update-worker", ...(force ? ["--force"] : [])];
	if (detectInstallMethod() === "bun-binary") {
		return updateArgs;
	}
	const modulePath = fileURLToPath(import.meta.url);
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	const cliMainPath = resolve(dirname(modulePath), "..", `cli-main${extension}`);
	return [...process.execArgv, cliMainPath, ...updateArgs];
}

export const defaultSpawnWorker: OmoLocalSpawnWorker = (request) => {
	const logPath = omoLocalUpdateWorkerLogPath(request.agentDir);
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		const logFd = openSync(logPath, "w");
		try {
			const child = spawn(process.execPath, workerCommandArgs(request.force), {
				detached: true,
				windowsHide: true,
				env: process.env,
				stdio: ["ignore", logFd, logFd],
			});
			child.unref();
			return { ok: true, pid: child.pid, logPath };
		} finally {
			closeSync(logFd);
		}
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
};
