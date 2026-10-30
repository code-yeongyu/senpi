import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["lifetime", "frames", "transfer", "worker-data", "error", "close"])(
	"preserves Worker %s through real Bun eval",
	async (scenario) => {
		const driver = fileURLToPath(new URL("./fixtures/permission-worker-driver.ts", import.meta.url));
		const child = spawn("bun", [driver, scenario], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += String(data);
		});
		child.stderr.on("data", (data) => {
			stderr += String(data);
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const timer = setTimeout(() => child.kill(), 40_000);
		try {
			expect(await exited, `${stdout}\n${stderr}`).toBe(0);
			expect(JSON.parse(stdout.trim())).toEqual({ scenario, rows: 6, failures: [] });
		} finally {
			clearTimeout(timer);
			child.kill();
		}
	},
	45_000,
);
