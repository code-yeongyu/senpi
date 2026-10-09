import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { buildFocusRequest, KEY, mountFocus } from "./ask-user-question-focus-support.ts";

const ALPHABET = [
	KEY.up,
	KEY.down,
	KEY.left,
	KEY.tab,
	KEY.shiftTab,
	KEY.enter,
	KEY.esc,
	KEY.backspace,
	KEY.space,
	"1",
	"x",
];
const DEPTH = 3;

function snapshot(waitForAnswer: boolean, sequence: string[]): { render: string; settled: boolean } {
	const h = mountFocus(buildFocusRequest(waitForAnswer));
	h.keys(...sequence);
	return { render: h.render(), settled: h.doneCalls.length > 0 };
}

function atTop(render: string): boolean {
	return render.includes("→ 1. ") || render.includes("→ Auth:");
}

function reacts(waitForAnswer: boolean, sequence: string[], probe: string, baseRender: string): boolean {
	const after = snapshot(waitForAnswer, [...sequence, probe]);
	return after.settled || after.render !== baseRender;
}

function assertNavigable(waitForAnswer: boolean, sequence: string[]): void {
	const base = snapshot(waitForAnswer, sequence);
	if (base.settled) return;
	const label = `${waitForAnswer ? "wait" : "async"} ${JSON.stringify(sequence)}`;
	for (const probe of [KEY.tab, KEY.esc]) {
		expect(
			reacts(waitForAnswer, sequence, probe, base.render),
			`${label} + ${JSON.stringify(probe)} did nothing`,
		).toBe(true);
	}
	if (!atTop(base.render)) {
		expect(reacts(waitForAnswer, sequence, KEY.up, base.render), `${label} + UP did nothing`).toBe(true);
	}
}

describe("ask-user overlay reachability guard", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("no key sequence up to depth 3 leaves a state where Tab, Esc or Up is silently swallowed", () => {
		for (const waitForAnswer of [true, false]) {
			let frontier: string[][] = [[]];
			for (let depth = 0; depth < DEPTH; depth += 1) {
				const next: string[][] = [];
				for (const sequence of frontier) {
					for (const key of ALPHABET) {
						const candidate = [...sequence, key];
						assertNavigable(waitForAnswer, candidate);
						next.push(candidate);
					}
				}
				frontier = next;
			}
		}
	});
});
