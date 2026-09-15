#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PhotonImage } from "@silvia-odwyer/photon-node";

const width = 200;
const height = 200;
// Mutable RGBA drawing buffer: opaque white, with a radius-50 red circle.
const pixels = new Uint8Array(width * height * 4).fill(255);
for (let y = 0; y < height; y++) {
	for (let x = 0; x < width; x++) {
		if ((x + 0.5 - 100) ** 2 + (y + 0.5 - 100) ** 2 < 50 ** 2) {
			const offset = (y * width + x) * 4;
			pixels[offset + 1] = 0;
			pixels[offset + 2] = 0;
		}
	}
}

const image = new PhotonImage(pixels, width, height);
const outputPath = fileURLToPath(new URL("../test/data/red-circle.png", import.meta.url));
try {
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, image.get_bytes());
} finally {
	image.free();
}
console.log(`Generated test image at: ${outputPath}`);
