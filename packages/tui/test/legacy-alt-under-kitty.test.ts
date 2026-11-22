/**
 * Legacy ESC-prefixed Alt chords while the Kitty keyboard protocol is negotiated (senpi#6058).
 *
 * Under ConPTY (WSL in Windows Terminal) the outer terminal answers the Kitty flags query, but the
 * bytes the process reads are encoded by the console host in legacy form, so Alt+Q arrives as
 * `ESC q`. A conforming Kitty terminal sends the Escape key as `CSI 27 u`, so a raw ESC plus a
 * printable key can only be a legacy Alt chord.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { matchesKey, parseKey, setKittyProtocolActive } from "../src/keys.ts";
import { StdinBuffer } from "../src/stdin-buffer.ts";

const ESC = "\x1b";
const WSL_ESCAPE_WINDOW_MS = 100;

function decode(reads: ReadonlyArray<readonly [number, string]>): string[] {
	let now = 0;
	const emitted: string[] = [];
	const buffer = new StdinBuffer({ escapeTimeout: WSL_ESCAPE_WINDOW_MS, now: () => now });
	buffer.on("data", (sequence) => emitted.push(sequence));
	for (const [gapMs, bytes] of reads) {
		now += gapMs;
		buffer.process(bytes);
	}
	buffer.destroy();
	return emitted;
}

const ALT_Q_PATHS: ReadonlyArray<{ name: string; reads: ReadonlyArray<readonly [number, string]> }> = [
	{ name: "ESC q in one read", reads: [[0, `${ESC}q`]] },
	{
		name: "ESC | q split inside the window",
		reads: [
			[0, ESC],
			[70, "q"],
		],
	},
	{ name: "Kitty CSI 113;3u", reads: [[0, `${ESC}[113;3u`]] },
	{ name: "modifyOtherKeys CSI 27;3;113~", reads: [[0, `${ESC}[27;3;113~`]] },
];

describe("legacy Alt chords with the Kitty protocol negotiated (#6058)", () => {
	afterEach(() => setKittyProtocolActive(false));

	for (const kitty of [false, true]) {
		for (const path of ALT_Q_PATHS) {
			it(`${path.name} is alt+q (kitty ${kitty ? "active" : "inactive"})`, () => {
				setKittyProtocolActive(kitty);
				const sequences = decode(path.reads);
				assert.deepStrictEqual(
					sequences.map((sequence) => matchesKey(sequence, "alt+q")),
					[true],
				);
				assert.deepStrictEqual(sequences.map(parseKey), ["alt+q"]);
			});
		}
	}

	it("every legacy alt+printable default on WSL decodes while Kitty is active", () => {
		setKittyProtocolActive(true);
		for (const key of ["q", "v", "z", "a", "1", ",", "."] as const) {
			const keyId = `alt+${key}` as const;
			assert.strictEqual(matchesKey(`${ESC}${key}`, keyId), true, keyId);
			assert.strictEqual(parseKey(`${ESC}${key}`), keyId, keyId);
		}
	});

	it("an ESC that arrives beyond the window stays Escape followed by q", () => {
		setKittyProtocolActive(true);
		const sequences = decode([
			[0, ESC],
			[WSL_ESCAPE_WINDOW_MS + 50, "q"],
		]);
		assert.deepStrictEqual(sequences, [ESC, "q"]);
		assert.deepStrictEqual(sequences.map(parseKey), ["escape", "q"]);
		assert.deepStrictEqual(
			sequences.map((sequence) => matchesKey(sequence, "alt+q")),
			[false, false],
		);
	});

	it("Kitty-mode mappings for ESC CR, ESC B and ESC F are unchanged", () => {
		setKittyProtocolActive(true);
		assert.strictEqual(parseKey(`${ESC}\r`), "shift+enter");
		assert.strictEqual(matchesKey(`${ESC}B`, "alt+left"), false);
		assert.strictEqual(parseKey(`${ESC}B`), undefined);
		assert.strictEqual(matchesKey(`${ESC}F`, "alt+right"), false);
		assert.strictEqual(parseKey(`${ESC}F`), undefined);
	});
});
