import { beforeAll, describe, expect, it } from "vitest";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import {
	type FooterRightForm,
	type FooterSegment,
	planFooterLayout,
} from "../src/modes/interactive/components/footer-layout.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	createFooterData,
	createFooterSession as createFooterSessionFixture,
	type FooterSessionOptions,
} from "./helpers/footer-test-fixtures.ts";

function createFooterSession(options: FooterSessionOptions) {
	const session = createFooterSessionFixture(options);
	Object.assign(session, { modelRuntime: { isUsingSubscription: () => false } });
	return session;
}

beforeAll(() => {
	initTheme(undefined, false);
});

function seg(plain: string): FooterSegment {
	return { plain, colored: plain };
}

describe("planFooterLayout provider priority", () => {
	const anchor: [FooterSegment, ...FooterSegment[]] = [seg("~/local-workspaces/senpi"), seg("main")];
	const middle = [seg("session-name"), seg("↑1.2M"), seg("↓45K"), seg("CH92.3%"), seg("$12.345")];
	const tail = seg("120K/1M (12.0%) (auto)");
	const right = {
		forms: [
			{ ...seg("(anthropic) claude-opus-5:low"), fitsWith: "middle-elision" as const },
			seg("claude-opus-5:low"),
		] as [FooterRightForm, ...FooterRightForm[]],
	};
	const baseInput = {
		anchor,
		pwdIndex: 0,
		middle,
		tail,
		right,
		separator: " • ",
		minPadding: 2,
		ellipsisMarker: seg("…"),
	};

	it("keeps the provider prefix once a middle stat has to elide", () => {
		const plan = planFooterLayout({ ...baseInput, width: 124 });
		expect(plan.kind).toBe("middle-elided");
		if (plan.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(plan.keptMiddleCount).toBe(3);
		expect(plan.showMarker).toBe(true);
		expect(plan.rightForm).toBe(0);
	});

	it("falls back to the bare model label when even empty middle cannot fit the full label", () => {
		const plan = planFooterLayout({ ...baseInput, width: 75 });
		expect(plan.kind).toBe("middle-elided");
		if (plan.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(plan.keptMiddleCount).toBe(0);
		expect(plan.showMarker).toBe(false);
		expect(plan.rightForm).toBe(1);
	});

	it("accepts a form that must fit with everything only in the full layout", () => {
		const ladder = {
			forms: [
				{ ...seg("(anthropic) claude-opus-5 • effort low (shift+tab)"), fitsWith: "everything" as const },
				{ ...seg("(anthropic) claude-opus-5 • effort low"), fitsWith: "everything" as const },
				{ ...seg("(anthropic) claude-opus-5:low"), fitsWith: "middle-elision" as const },
				seg("claude-opus-5:low"),
			] as [FooterRightForm, ...FooterRightForm[]],
		};
		const everything = planFooterLayout({ ...baseInput, right: ladder, width: 160 });
		expect(everything).toEqual({ kind: "full", rightForm: 0 });

		const oneStatShort = planFooterLayout({ ...baseInput, right: ladder, width: 130 });
		expect(oneStatShort.kind).toBe("middle-elided");
		if (oneStatShort.kind !== "middle-elided") throw new Error("unexpected plan");
		expect(oneStatShort.rightForm).toBe(2);
		expect(oneStatShort.keptMiddleCount).toBeGreaterThan(0);
	});

	it("lets the level-bearing floor shorten the path instead of dropping the level", () => {
		const ladder = {
			forms: [
				{ ...seg("(anthropic) claude-opus-5 • effort low"), fitsWith: "everything" as const },
				{ ...seg("(anthropic) claude-opus-5:low"), fitsWith: "middle-elision" as const },
				seg("claude-opus-5:low"),
			] as [FooterRightForm, ...FooterRightForm[]],
		};
		const plan = planFooterLayout({ ...baseInput, right: ladder, width: 62 });
		expect(plan.kind).toBe("pwd-elided");
		if (plan.kind !== "pwd-elided") throw new Error("unexpected plan");
		expect(plan.rightForm).toBe(2);
		expect(plan.pwdPlain).toMatch(/^…/);
	});

	it("keeps the existing pwd-elided and anchor/tail guarantees untouched", () => {
		const plan = planFooterLayout({ ...baseInput, width: 60 });
		expect(plan.kind).toBe("pwd-elided");
		if (plan.kind !== "pwd-elided") throw new Error("unexpected plan");
		expect(plan.pwdPlain.length).toBeGreaterThan(0);
	});

	it("marks explicitly identified subscription auth", () => {
		const session = createFooterSession({ sessionName: "", provider: "anthropic" });
		Object.assign(session, { modelRuntime: { isUsingSubscription: () => true } });
		const footer = new FooterComponent(session, createFooterData(1));

		expect(stripAnsi(footer.render(120)[0])).toContain("$0.000 (sub)");
	});

	it("does not mark non-subscription auth as a subscription", () => {
		const session = createFooterSession({
			sessionName: "",
			provider: "openrouter",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 1.234 } },
		});
		Object.assign(session, { modelRuntime: { isUsingSubscription: () => false } });
		const footer = new FooterComponent(session, createFooterData(1));
		const stats = stripAnsi(footer.render(120)[0]);

		expect(stats).toContain("$1.234");
		expect(stats).not.toContain("(sub)");
	});
});
