import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CHILD_TIMEOUT_MS = 20_000;
const tempDirs: string[] = [];

function shortPath(path: string): string | undefined {
	try {
		const result = execFileSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${path}") do @echo %~sI`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return result && result !== path ? result : undefined;
	} catch {
		return undefined;
	}
}

function nonCanonicalTempDir(): string | undefined {
	const rawTempDir = tmpdir();
	if (rawTempDir !== realpathSync.native(rawTempDir)) {
		const directory = mkdtempSync(join(rawTempDir, "senpi-1229-long-directory-"));
		tempDirs.push(directory);
		return directory;
	}

	const longDirectory = mkdtempSync(join(rawTempDir, "senpi-1229-long-directory-name-"));
	tempDirs.push(longDirectory);
	const alias = shortPath(longDirectory);
	if (!alias) {
		rmSync(longDirectory, { recursive: true, force: true });
		tempDirs.pop();
	}
	return alias;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform !== "win32")("issue #1229 non-canonical fs.watch path", () => {
	it("does not abort the process when a watched file changes", async (ctx) => {
		const directory = nonCanonicalTempDir();
		if (!directory) {
			ctx.skip("The Windows volume does not expose an 8.3 short alias");
			return;
		}

		const wrapperPath = resolve(__dirname, "../../../src/utils/fs-watch.ts");
		const scriptPath = join(directory, "watch-child.ts");
		const script = `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchWithErrorHandler } from ${JSON.stringify(pathToFileURL(wrapperPath).href)};

// Watch the DIRECTORY through its non-canonical (8.3 short-name) path. On
// unfixed code libuv aborts the whole process (fs-event.c uv__relative_path
// assertion) as soon as a directory entry event arrives; file watches never
// enter that code path, so this must stay a directory watch.
const directory = ${JSON.stringify(directory)};
let completed = false;
const timeout = setTimeout(() => process.exit(2), 10000);
const watcher = watchWithErrorHandler(
  directory,
  () => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    watcher?.close();
    process.exit(0);
  },
  () => {
    clearTimeout(timeout);
    process.exit(3);
  },
);
if (!watcher) {
  clearTimeout(timeout);
  process.exit(4);
}
writeFileSync(join(directory, "regression-write-1229.txt"), "change");
`;
		writeFileSync(scriptPath, script);
		const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
			cwd: resolve(__dirname, "../../../../.."),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
			const timeout = setTimeout(() => {
				child.kill();
				reject(new Error(`Child timed out after ${CHILD_TIMEOUT_MS}ms`));
			}, CHILD_TIMEOUT_MS);
			child.once("error", reject);
			child.once("close", (code, signal) => {
				clearTimeout(timeout);
				resolveExit({ code, signal });
			});
		});

		expect(exit.code, `Child exited with code ${exit.code} (signal ${exit.signal}). stderr: ${stderr.trim()}`).toBe(
			0,
		);
	});
});
