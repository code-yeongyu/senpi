import { execFileSync } from "node:child_process";

// execFileSync's default 1 MiB maxBuffer fails `git show` of a large file with ENOBUFS: packages/coding-agent/CHANGELOG.md
// passed 1 MiB and the pinned v2026.10.19-1 release died merging main back (run 39296257099).
export const CAPTURE_MAX_BUFFER = 256 * 1024 * 1024;

export function captureOutput(bin, args) {
	return execFileSync(bin, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: CAPTURE_MAX_BUFFER });
}
