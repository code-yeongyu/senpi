import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("decides nested imports and module bodies under the importing cell's authority", async () => {
	const child = spawn(
		"bun",
		[fileURLToPath(new URL("./fixtures/permission-module-chain-driver.ts", import.meta.url))],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
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
	const deadline = setTimeout(() => child.kill(), 150_000);
	try {
		expect(await exited, `${stderr}\n${stdout}`).toBe(0);
	} finally {
		clearTimeout(deadline);
		child.kill();
	}
}, 160_000);
