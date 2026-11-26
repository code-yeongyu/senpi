import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveGrepEngine } from "../../src/core/tools/grep/select-engine.ts";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "identity-grep-"));
	vi.stubEnv("HOME", home);
	mkdirSync(join(home, ".omo"));
	mkdirSync(join(home, "tree"));
	writeFileSync(join(home, ".omo/device-identity.json"), '{"fixture":"SYNTHETIC"}');
	writeFileSync(join(home, "tree/ordinary"), "ordinary");
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

for (const kind of ["rg", "native"] as const) {
	it.skipIf(kind === "native" && !process.env.SENPI_GREP_NATIVE_PATH)(
		`${kind}: recursive discovery refuses an identity hard link at content access`,
		async () => {
			const engine = await resolveGrepEngine({ env: { ...process.env, SENPI_GREP_ENGINE: kind } });
			const request = { cwd: home, paths: [join(home, "tree")], pattern: "ordinary", gitignore: false };
			expect((await engine.search(request)).matches.length).toBe(1);
			linkSync(join(home, ".omo/device-identity.json"), join(home, "tree/ordinary-name"));
			const refused = await engine.search(request).then(
				() => false,
				(e: unknown) => String(e).includes("IDENTITY_FILE_REFUSED"),
			);
			expect(refused).toBe(true);
		},
	);
}
