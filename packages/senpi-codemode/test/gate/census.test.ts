import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { helperCandidates } from "../../scripts/gate-census.ts";

it("discovers Ruby installation assets and punctuation-suffixed Ruby and Julia helpers", async () => {
	// Given: both Ruby installation assets and a Julia mutating helper.
	const root = await mkdtemp(join(tmpdir(), "senpi-gate-census-"));
	try {
		await mkdir(join(root, "src/kernels/rb"), { recursive: true });
		await mkdir(join(root, "src/kernels/jl"), { recursive: true });
		await writeFile(join(root, "src/kernels/rb/prelude.rb"), "def normalize!\nend\ndef valid?\nend");
		await writeFile(join(root, "src/kernels/rb/workpool.rb"), "def pooled_helper\nend");
		await writeFile(join(root, "src/kernels/jl/prelude.jl"), "function normalize!(value)\nend");
		// When: the gate reads the real installation seam.
		const ruby = await helperCandidates({ target: root, language: "rb", golden: [] });
		const julia = await helperCandidates({ target: root, language: "jl", golden: [] });
		// Then: these callable public additions can reach the initialized-kernel witness.
		expect(ruby).toEqual(["normalize!", "pooled_helper", "valid?"]);
		expect(julia).toEqual(["normalize!"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
