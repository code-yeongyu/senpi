import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeTempDir } from "../../../../scripts/vitest-temp.ts";

export function makeRoot(): { agentDir: string; cwd: string } {
	const root = makeTempDir(join(tmpdir(), "senpi-mcp-config-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".senpi"), { recursive: true });
	return { agentDir, cwd };
}

export function writeJson(path: string, value: unknown): void {
	writeRaw(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeRaw(path: string, value: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, value);
}
