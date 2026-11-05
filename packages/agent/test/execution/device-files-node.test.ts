// senpi#5691 review: a device file read or write of a path that is not a regular file is refused at once. A named pipe
// with no peer would otherwise hold the open (and a worker thread) forever, and an abort could not end it.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localDeviceFiles } from "../../src/execution/device-files-node.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fifo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-device-fifo-"));
	dirs.push(dir);
	const path = join(dir, "pipe");
	execFileSync("mkfifo", [path]);
	return path;
}

describe.skipIf(process.platform === "win32")(
	"local device files refuse what is not a regular file (senpi#5691)",
	() => {
		it("refuses to read a named pipe instead of waiting for a writer", async () => {
			const path = await fifo();

			await expect(localDeviceFiles().read(path)).rejects.toMatchObject({ code: "not_a_file" });
		});

		it("refuses to write a named pipe instead of waiting for a reader", async () => {
			const path = await fifo();

			await expect(localDeviceFiles().write(path, new Uint8Array(1))).rejects.toMatchObject({ code: "not_a_file" });
		});
	},
);
