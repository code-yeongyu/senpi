import { describe, expect, it } from "vitest";
import { accountDisplayName, accountLabel, displayNameColumns, renameSlotDisplayName } from "../src/auth/pool/slots.ts";

const HANGUL_FILLER = "\u3164";
const BRAILLE_BLANK = "\u2800";
const NFD_CAFE = "Cafe\u0301"; // NFD
const NFC_CAFE = "Caf\u00e9"; // NFC

function pool(displayNames: Array<string | undefined>) {
	return {
		type: "oauth" as const,
		access: "fake-a",
		refresh: "fake-r",
		expires: 1,
		accounts: displayNames.map((displayName, index) => ({
			name: `slot-${index + 1}`,
			...(displayName === undefined ? {} : { displayName }),
			access: "fake-a",
			refresh: "fake-r",
			expires: 1,
			source: "login" as const,
		})),
	};
}

// senpi#1495 review: labels are validated in terminal columns and compared
// under a fold of case, compatibility forms, whitespace, invisible code points
// and Cyrillic lookalikes, so two labels that render identically cannot coexist.
describe("accountDisplayName validation", () => {
	it("normalizes to NFC and collapses internal whitespace runs in the stored form", () => {
		expect(accountDisplayName(`  ${NFD_CAFE} `)).toBe(NFC_CAFE);
		expect(accountDisplayName("Work  account")).toBe("Work account");
	});

	it("measures the limit in terminal columns, not UTF-16 code units", () => {
		// 20 CJK graphemes are 40 columns: over the 32-column bound even though
		// only 20 code units.
		expect(accountDisplayName("中".repeat(20))).toBeUndefined();
		expect(accountDisplayName("中".repeat(16))).toBe("中".repeat(16));
		// 16 emoji are 32 columns and must pass even though they are 32 code units.
		const emoji = "🎉".repeat(16);
		expect(accountDisplayName(emoji)).toBe(emoji);
		const emojiOver = "🎉".repeat(17);
		expect(accountDisplayName(emojiOver)).toBeUndefined();
		expect(displayNameColumns("中中")).toBe(4);
		expect(displayNameColumns("aa")).toBe(2);
	});

	it("rejects names that render as blank or begin with a combining mark", () => {
		expect(accountDisplayName(HANGUL_FILLER)).toBeUndefined();
		expect(accountDisplayName(HANGUL_FILLER.repeat(3))).toBeUndefined();
		expect(accountDisplayName(BRAILLE_BLANK.repeat(3))).toBeUndefined();
		expect(accountDisplayName(" \t ")).toBeUndefined();
		expect(accountDisplayName("\u0301abc")).toBeUndefined();
		// The same blank code point must not smuggle near-duplicates through.
		expect(accountDisplayName(`Work${HANGUL_FILLER}`)).toBe(`Work${HANGUL_FILLER}`);
	});

	it("omits hand-written metadata that fails validation from labels", () => {
		expect(accountLabel({ name: "default", displayName: HANGUL_FILLER })).toBe("default");
		expect(accountLabel({ name: "default", displayName: ` ${NFD_CAFE} ` })).toBe(`${NFC_CAFE} (default)`);
	});
});

describe("display-name uniqueness fold", () => {
	it("rejects whitespace, NFC/NFD, fullwidth, invisible and homoglyph duplicates", async () => {
		for (const [existing, duplicate] of [
			["Work account", "Work  account"],
			[NFC_CAFE, NFD_CAFE],
			["Work", "Ｗork"],
			["Work", `Work${HANGUL_FILLER}`],
			["Bork", "\u0412ork"],
		] as const) {
			const credential = renameSlotDisplayName(pool([undefined, existing]), "slot-2", existing);
			expect(() => renameSlotDisplayName(credential, "slot-1", duplicate)).toThrow(/already used/);
		}
	});

	it("keeps distinct renderings distinct", async () => {
		const credential = renameSlotDisplayName(pool([undefined, undefined]), "slot-1", "Work account");
		expect(() => renameSlotDisplayName(credential, "slot-2", "Workaccount")).not.toThrow();
		expect(() => renameSlotDisplayName(credential, "slot-2", "Wörk")).not.toThrow();
	});

	it("pins the rejection message for invalid labels", async () => {
		expect(() => renameSlotDisplayName(pool([undefined]), "slot-1", "中".repeat(40))).toThrow(
			/1-32 terminal columns/,
		);
		expect(() => renameSlotDisplayName(pool([undefined]), "slot-1", "")).toThrow(/1-32 terminal columns/);
		expect(() => renameSlotDisplayName(pool([undefined]), "missing", "Valid")).toThrow(/not found/);
	});
});
