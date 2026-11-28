import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// senpi#4527: under Bun, a cell's import() of a patched built-in sees the owned export, as require does.
it("hands a Bun cell the owned export through import(), the same as through the CJS object", async () => {
	const driver = fileURLToPath(new URL("./fixtures/builtin-namespace-driver.ts", import.meta.url));
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
	const timer = setTimeout(() => child.kill(), 40_000);
	try {
		expect(await exited, `${stdout}\n${stderr}`).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({ ok: true, differ: [] });
	} finally {
		clearTimeout(timer);
		child.kill();
	}
}, 45_000);
