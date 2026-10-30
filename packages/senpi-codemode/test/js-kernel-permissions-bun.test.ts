import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("enforces Bun spawn, static imports and pre-enforcement Workers through real eval", async () => {
	const driver = fileURLToPath(new URL("./fixtures/permission-bun-driver.ts", import.meta.url));
	const child = spawn("bun", [driver], { stdio: ["ignore", "pipe", "pipe"] });
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
	const timer = setTimeout(() => child.kill(), 25_000);
	try {
		expect(await exited, stderr).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({ ok: true, modes: 2, activeStates: 2, nestedRevocation: true });
	} finally {
		clearTimeout(timer);
		child.kill();
	}
});
