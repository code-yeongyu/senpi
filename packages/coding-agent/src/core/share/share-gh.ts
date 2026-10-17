import { spawn, spawnSync } from "node:child_process";
import type { ShareUploadResult } from "./share-session.ts";

export function checkGhAuth(): "ok" | "missing" | "logged-out" {
	const result = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
	if (result.error !== undefined) return "missing";
	return result.status === 0 ? "ok" : "logged-out";
}

/** Creates a secret gist from `html` piped through stdin, so the export never lands on disk. */
export function uploadSecretGist(html: string, fileName: string, signal: AbortSignal): Promise<ShareUploadResult> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ code: null, stdout: "", stderr: "", aborted: true });
			return;
		}
		const child = spawn("gh", ["gist", "create", "--filename", fileName, "-"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const onAbort = () => child.kill();
		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (error) => {
			signal.removeEventListener("abort", onAbort);
			resolve({ code: null, stdout, stderr: error.message, aborted: signal.aborted });
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, aborted: signal.aborted });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(html);
	});
}
