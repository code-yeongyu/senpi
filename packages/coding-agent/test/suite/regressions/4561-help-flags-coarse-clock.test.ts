import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readHelpFlagsCache, writeHelpFlagsCache } from "../../../src/cli/help-flags-cache.ts";

// senpi#4561: on a filesystem whose clock is coarser than the write (FAT, HFS+), a change made in the
// same tick as the cache write leaves mtime, ctime and size unchanged. The stat below reports the
// timestamps the coarse clock would, frozen at the tick of the write.
const clock = vi.hoisted(() => ({ frozenAt: undefined as number | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const statSync = ((path: string) => {
		const stats = actual.statSync(path);
		if (clock.frozenAt === undefined) return stats;
		return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
			mtimeMs: clock.frozenAt,
			ctimeMs: clock.frozenAt,
		});
	}) as typeof actual.statSync;
	return { ...actual, statSync };
});

let hostDir: string;

beforeEach(() => {
	hostDir = mkdtempSync(join(tmpdir(), "senpi-4561-"));
});

afterEach(() => {
	clock.frozenAt = undefined;
	rmSync(hostDir, { recursive: true, force: true });
});

it("rejects a same-tick same-size edit and a same-tick new extension on a coarse clock", () => {
	const agentDir = join(hostDir, "agent");
	const projectDir = join(hostDir, "project");
	const extensionsDir = join(agentDir, "extensions");
	const extensionPath = join(extensionsDir, "probe.js");
	mkdirSync(extensionsDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(extensionPath, "export default function alpha() {}\n");
	const scope = { cwd: projectDir, agentDir, cliExtensionPaths: [], noExtensions: false, projectTrusted: true };
	const flags = [{ name: "probe", type: "boolean" as const, default: false, extensionPath }];
	clock.frozenAt = Date.now();

	writeHelpFlagsCache({ scope, flags, extensionPaths: [extensionPath] });
	expect(readHelpFlagsCache(scope)).toEqual(flags);

	writeFileSync(extensionPath, "export default function omega() {}\n");
	expect(readHelpFlagsCache(scope)).toBeUndefined();

	writeHelpFlagsCache({ scope, flags, extensionPaths: [extensionPath] });
	writeFileSync(join(extensionsDir, "probe-2.js"), "export default function beta() {}\n");
	expect(readHelpFlagsCache(scope)).toBeUndefined();
});
