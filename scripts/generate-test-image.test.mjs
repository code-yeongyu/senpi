#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";

it("generates the red circle fixture when only the portable image dependency is available", () => {
	// Given: an isolated generator, with Photon available but no native canvas install.
	const root = mkdtempSync(join(tmpdir(), "senpi-test-image-"));
	try {
		const scripts = join(root, "scripts");
		mkdirSync(scripts);
		const generator = join(scripts, "generate-test-image.ts");
		copyFileSync(new URL("../packages/ai/scripts/generate-test-image.ts", import.meta.url), generator);
		const dependency = join(root, "node_modules/@silvia-odwyer/photon-node");
		mkdirSync(dirname(dependency), { recursive: true });
		symlinkSync(dirname(createRequire(import.meta.url).resolve("@silvia-odwyer/photon-node")), dependency, "junction");

		// When: the real generator is invoked with no existing output directory.
		const result = spawnSync(process.execPath, [generator], { encoding: "utf8", timeout: 30000 });

		// Then: it writes an opaque 200x200 PNG with a radius-50 red circle on white.
		assert.equal(result.status, 0, result.stderr);
		const image = PhotonImage.new_from_byteslice(readFileSync(join(root, "test/data/red-circle.png")));
		try {
			assert.equal(image.get_width(), 200);
			assert.equal(image.get_height(), 200);
			const pixels = image.get_raw_pixels();
			for (const [x, y, color] of [[100, 100, [255, 0, 0, 255]], [51, 100, [255, 0, 0, 255]], [149, 100, [255, 0, 0, 255]], [49, 100, [255, 255, 255, 255]], [151, 100, [255, 255, 255, 255]], [0, 0, [255, 255, 255, 255]], [199, 199, [255, 255, 255, 255]]]) {
				const offset = (y * 200 + x) * 4;
				assert.deepEqual([...pixels.slice(offset, offset + 4)], color);
			}
		} finally {
			image.free();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
