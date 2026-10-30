import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("hands a cell the engine's own worker_threads module unless the decision refuses it", async () => {
	const driver = fileURLToPath(new URL("./fixtures/permission-module-surface-driver.ts", import.meta.url));
	const child = spawn("bun", [driver], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	const deadline = setTimeout(() => child.kill(), 180_000);
	try {
		expect(await exited, `${stderr}\n${stdout}`).toBe(0);
		const report: unknown = JSON.parse(stdout.trim());
		expect(report).toMatchObject({ failures: [] });
	} finally {
		clearTimeout(deadline);
		child.kill();
	}
}, 190_000);
