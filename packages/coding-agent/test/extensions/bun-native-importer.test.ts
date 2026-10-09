import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// A plain `bun` runtime (every bun-global install) must load TypeScript extensions
// through Bun.Transpiler, not through jiti + Babel. The probe observes jiti
// resolution from inside the real boot instead of asserting on timings.
const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
if (!bunAvailable) {
	console.warn("[bun-native-importer] skipped: `bun` is not on PATH; install bun to run this regression");
}

const probeSource = `
import { appendFileSync } from "node:fs";
const marker = process.env.SENPI_JITI_PROBE_MARKER;
Bun.plugin({
	name: "jiti-resolution-probe",
	setup(builder) {
		builder.onResolve({ filter: /jiti/ }, (args) => {
			appendFileSync(marker, args.path + "\\n");
			return undefined;
		});
	},
});
`;

const extensionSource = `
import type { KeyId } from "@earendil-works/pi-tui";
import { probeFlagName } from "./helper.ts";

const keyLabel = (key: KeyId): string => \`\${key}\`;

export default function (pi: { registerFlag(name: string, options: { type: "boolean"; description: string }): void }) {
	pi.registerFlag(probeFlagName, { type: "boolean", description: \`bun native probe (\${keyLabel("escape")})\` });
}
`;

const helperSource = 'export const probeFlagName: string = "bun-native-probe";\n';

const roots: string[] = [];

// Avoid "jiti" anywhere in the fixture paths: the probe filter matches specifiers.
function fixture(): { extension: string; probe: string; marker: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-bun-native-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	writeFileSync(join(root, "ext.ts"), extensionSource);
	writeFileSync(join(root, "helper.ts"), helperSource);
	writeFileSync(join(root, "probe.ts"), probeSource);
	writeFileSync(join(root, "marker.txt"), "");
	return {
		extension: join(root, "ext.ts"),
		probe: join(root, "probe.ts"),
		marker: join(root, "marker.txt"),
		agentDir,
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!bunAvailable)("extension imports on a plain bun runtime", () => {
	it("loads a TypeScript extension without resolving jiti", () => {
		// Given: a real boot of the built CLI on bun, watched by a jiti-resolution probe.
		expect(existsSync(cliPath), `build dist first: ${cliPath} is missing`).toBe(true);
		const { extension, probe, marker, agentDir } = fixture();
		// When
		const run = spawnSync(
			"bun",
			[
				"--preload",
				probe,
				cliPath,
				"--extension",
				extension,
				"--bun-native-probe",
				"-p",
				"hi",
				"--model",
				"nope/nope",
			],
			{
				encoding: "utf8",
				timeout: 180_000,
				env: {
					...process.env,
					SENPI_CODING_AGENT_DIR: agentDir,
					SENPI_JITI_PROBE_MARKER: marker,
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
				},
			},
		);
		// Then: the boot reached model resolution, so extension loading really ran.
		const stderr = run.stderr ?? "";
		expect(stderr).toContain('Model "nope/nope" not found');
		expect(stderr).not.toContain("Failed to load extension");
		expect(stderr).not.toContain("Unknown option");
		expect(readFileSync(marker, "utf8").trim()).toBe("");
	}, 200_000);
});
