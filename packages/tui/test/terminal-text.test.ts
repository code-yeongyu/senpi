import assert from "node:assert";
import { describe, it } from "node:test";
import { imageFallback } from "../src/terminal-text.ts";

const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function assertSafeImageLabel(label: string): void {
	assert.doesNotMatch(label, TERMINAL_CONTROL_PATTERN);
	assert.ok(!label.includes("\x1b"));
	assert.ok(!label.includes("\x07"));
	assert.ok(!label.includes("\x1b]"));
}

describe("imageFallback", () => {
	it("Given normal image metadata when rendered then the existing label format is preserved", () => {
		// Given
		const dimensions = { widthPx: 640, heightPx: 480 };

		// When
		const label = imageFallback("image/png", dimensions, "preview.png");

		// Then
		assert.strictEqual(label, "[Image: preview.png [image/png] 640x480]");
	});

	it("Given hostile MIME and filename labels when rendered then terminal controls are inert", () => {
		// Given
		const hostileMimeType = "image/png\x1b]52;c;SGVsbG8=\x07";
		const hostileFilename = "preview\x1b]0;owned\x07\u009b31m\x00.png";

		// When
		const label = imageFallback(hostileMimeType, { widthPx: 1, heightPx: 1 }, hostileFilename);

		// Then
		assertSafeImageLabel(label);
		assert.ok(!label.includes("SGVsbG8="));
		assert.ok(!label.includes("owned"));
	});
});
