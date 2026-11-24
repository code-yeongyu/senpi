/**
 * Regression #7417: `host` and `host session` answer through emit(), which called writeSync(1, line) once.
 * On a pipe, writeSync accepts only what fits the pipe buffer, so a large answer was cut at 64 KiB.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const emitModule = fileURLToPath(new URL("../../../src/cli/host-emit.ts", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function readEmitted(payloadSize: number): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "senpi-7417-"));
	tempDirs.push(dir);
	const fixture = join(dir, "fixture.ts");
	writeFileSync(
		fixture,
		[
			`import { emit } from ${JSON.stringify(emitModule)};`,
			"process.stdout.write('');",
			`emit({ data: "x".repeat(${payloadSize}) });`,
		].join("\n"),
	);
	return new Promise((resolve, reject) => {
		const child = spawn("bun", [fixture], { stdio: ["ignore", "pipe", "inherit"] });
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", reject);
		child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

describe.skipIf(process.platform === "win32")("#7417 host emit over a pipe", () => {
	test("a payload larger than the pipe buffer arrives whole", async () => {
		const output = await readEmitted(500_000);
		expect(output.endsWith("\n")).toBe(true);
		expect(JSON.parse(output)).toEqual({ data: "x".repeat(500_000) });
	});
});
