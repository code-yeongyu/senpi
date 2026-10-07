import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { commonBuildOptions, validateExternalImports } from "./build-coding-agent-bundle.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// The PTY loader resolves native files relative to its own package directory, so inlining it
// into the bundle would point it at the bundle directory instead.
const NATIVE_SIDECAR_PACKAGES = ["@earendil-works/pi-pty"];

describe("build-coding-agent-bundle", () => {
	it("keeps native-sidecar packages external when coding-agent imports them", async () => {
		// Given: a coding-agent module importing every native-sidecar package.
		const contents = NATIVE_SIDECAR_PACKAGES.map((name, index) => `import * as native${index} from "${name}";\nconsole.log(native${index});`).join("\n");

		// When
		const result = await build({
			...commonBuildOptions(),
			stdin: { contents, loader: "js", resolveDir: join(repoRoot, "packages", "coding-agent"), sourcefile: "probe.js" },
			write: false,
		});

		// Then
		const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports);
		assert.deepEqual(
			NATIVE_SIDECAR_PACKAGES.filter((name) => !imports.some((imported) => imported.path === name && imported.external)),
			[],
		);
		assert.doesNotThrow(() => validateExternalImports([result.metafile]));
	});
});
