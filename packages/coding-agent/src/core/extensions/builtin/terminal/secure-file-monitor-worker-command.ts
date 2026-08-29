import { basename } from "node:path";
import {
	SECURE_FILE_MONITOR_WORKER_FLAG,
	SECURE_FILE_MONITOR_WORKER_SOURCE,
} from "./secure-file-monitor-worker-source.ts";

export function resolveDefaultWorkerCommand(
	runtime: {
		readonly execPath: string;
		readonly versions: NodeJS.ProcessVersions | { readonly bun: string };
	} = process,
): readonly [string, ...string[]] {
	const isBun = "bun" in runtime.versions;
	const executableName = basename(runtime.execPath).toLowerCase();
	const isStandaloneBun = isBun && executableName !== "bun" && executableName !== "bun.exe";
	if (isStandaloneBun) return [runtime.execPath, SECURE_FILE_MONITOR_WORKER_FLAG];
	return [isBun ? "node" : runtime.execPath, "--input-type=commonjs", "-e", SECURE_FILE_MONITOR_WORKER_SOURCE];
}
