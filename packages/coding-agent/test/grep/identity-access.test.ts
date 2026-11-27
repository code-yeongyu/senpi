import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveGrepEngine } from "../../src/core/tools/grep/select-engine.ts";
import { observeRuleOpens } from "./observe-rule-opens.ts";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "identity-grep-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
	vi.stubEnv("OMO_DEVICE_SERVICE_STATE_DIR", join(home, "state"));
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
		`${kind}: prune identity directories before recursive ignore discovery`,
		async () => {
			const tree = join(home, "tree"),
				priv = join(tree, "private[1]");
			vi.stubEnv("OMO_DEVICE_SERVICE_STATE_DIR", priv);
			mkdirSync(priv);
			mkdirSync(join(tree, "elsewhere/private[1]"), { recursive: true });
			for (const f of [".gitignore", ".ignore", ".rgignore", "not-for-discovery"])
				writeFileSync(join(priv, f), "fixture-marker\n");
			writeFileSync(join(tree, ".gitignore"), "ignored-note\n");
			writeFileSync(join(tree, "ignored-note"), "fixture-marker\n");
			writeFileSync(join(tree, "elsewhere/private[1]/visible"), "fixture-marker\n");
			const engine = await resolveGrepEngine({ env: { ...process.env, SENPI_GREP_ENGINE: kind } });
			const result = await observeRuleOpens(
				join(tree, "elsewhere/private[1]/visible"),
				[".gitignore", ".ignore", ".rgignore", "not-for-discovery"].map((f) => join(priv, f)),
				() =>
					engine.search({
						cwd: tree,
						paths: [tree],
						pattern: "fixture-marker",
						hidden: true,
						gitignore: true,
					}),
			);
			expect(result.matches.map((m) => m.path)).toEqual(["elsewhere/private[1]/visible"]);
			expect(result.warnings).toHaveLength(0);
			await expect(engine.search({ cwd: tree, paths: [priv], pattern: "fixture-marker" })).rejects.toThrow(
				"IDENTITY_FILE_REFUSED",
			);
		},
	);
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
