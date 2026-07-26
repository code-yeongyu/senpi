/**
 * Golden test for the grok palette module (todo S2).
 *
 * The expected values below are transcribed directly from the authoritative
 * `## Palette` table in `.omo/plans/grok-neo.md` (capture-measured data).
 * If the module and this table ever disagree, one of them drifted from the
 * plan — fix the drift, not the assertion.
 */
import { describe, expect, it } from "vitest";
import {
	GROK_ACCENTS,
	GROK_BORDERS,
	GROK_DAY,
	GROK_GLYPHS,
	GROK_NIGHT,
	GROK_PALETTE,
	GROK_SURFACES,
	GROK_TEXT,
} from "../../src/modes/interactive/grok/palette.ts";

// Expected values re-derived from `.omo/plans/grok-neo.md` §Palette.
const PLAN_SURFACES = {
	base: "#141414",
	panel: "#111111",
	highlight: "#242424",
	altRow: "#1c1c1c",
	selected: "#363636",
} as const;

const PLAN_TEXT = {
	primary: "#e1e1e1",
	secondary: "#c8c8c8",
	muted: "#6c6c6c",
	dim: "#585858",
	faint: "#505058",
	label: "#808080",
} as const;

const PLAN_ACCENTS = {
	green: "#9ece6a",
	red: "#f7768e",
	blue: "#7aa2f7",
	yellow: "#e0af68",
	cyan: "#3a95ab",
} as const;

const PLAN_BORDERS = {
	input: "#505058",
	card: "#333333",
	modal: "#585858",
} as const;

const PLAN_GROK_NIGHT = {
	magenta: "#bb9af7",
	blue: "#7aa2f7",
	cyan: "#73daca",
	fg: "#c0caf5",
	green: "#9ece6a",
	red: "#f7768e",
} as const;

const PLAN_GROK_DAY = {
	blue: "#2F64D2",
	red: "#CD3048",
	green: "#0C947C",
} as const;

describe("grok palette golden (plan §Palette)", () => {
	it("matches the plan's Surfaces table", () => {
		expect(GROK_SURFACES).toEqual(PLAN_SURFACES);
	});

	it("matches the plan's Text table", () => {
		expect(GROK_TEXT).toEqual(PLAN_TEXT);
	});

	it("matches the plan's Accents table", () => {
		expect(GROK_ACCENTS).toEqual(PLAN_ACCENTS);
	});

	it("matches the plan's Borders table", () => {
		expect(GROK_BORDERS).toEqual(PLAN_BORDERS);
	});

	it("matches the plan's Grok Night table", () => {
		expect(GROK_NIGHT).toEqual(PLAN_GROK_NIGHT);
	});

	it("matches the plan's Grok Day table", () => {
		expect(GROK_DAY).toEqual(PLAN_GROK_DAY);
	});

	it("matches the plan's Glyphs table", () => {
		expect(GROK_GLYPHS.spinner).toBe("⠹");
		expect(GROK_GLYPHS.toolRow).toBe("┃ ◆");
	});

	it("aggregate view mirrors the individual constants", () => {
		expect(GROK_PALETTE).toEqual({
			surfaces: GROK_SURFACES,
			text: GROK_TEXT,
			accents: GROK_ACCENTS,
			borders: GROK_BORDERS,
			grokNight: GROK_NIGHT,
			grokDay: GROK_DAY,
			glyphs: GROK_GLYPHS,
		});
	});
});
