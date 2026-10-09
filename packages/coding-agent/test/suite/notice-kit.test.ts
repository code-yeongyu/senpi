import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNoticeBox,
	type NoticeSpec,
	noticeEntryRenderer,
	noticeMessageRenderer,
} from "../../src/core/extensions/notice/index.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import type { CustomEntry } from "../../src/core/session-manager.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const ANSI_PATTERN = /\[[0-9;]*m/g;

interface Marker {
	readonly marker: string;
}

function renderToText(spec: NoticeSpec, expanded = false): string {
	return buildNoticeBox(spec, { expanded }, theme).render(100).join("\n").replace(ANSI_PATTERN, "");
}

function rawRender(spec: NoticeSpec): string {
	return buildNoticeBox(spec, { expanded: false }, theme).render(100).join("\n");
}

function noticeMessage(details: Marker | undefined): CustomMessage<Marker> {
	return {
		role: "custom",
		customType: "test-notice",
		content: "content",
		display: true,
		details,
		timestamp: 0,
	};
}

function noticeEntry(data: Marker | undefined): CustomEntry<Marker> {
	return {
		type: "custom",
		id: "entry-1",
		parentId: null,
		timestamp: "2026-08-04T00:00:00.000Z",
		customType: "test-notice",
		data,
	};
}

describe("buildNoticeBox", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the title and why line", () => {
		const text = renderToText({ title: "Notice title", why: "why it happened" });
		expect(text).toContain("Notice title");
		expect(text).toContain("why it happened");
	});

	it("renders extra lines in order between the why line and the expanded detail", () => {
		const text = renderToText(
			{
				title: "t",
				why: "w",
				extra: [{ text: "extra-a", tone: "success" }, { text: "extra-b" }],
				expandedLine: "detail",
			},
			true,
		);
		expect(text).toContain("extra-a");
		expect(text).toContain("extra-b");
		expect(text.indexOf("w")).toBeLessThan(text.indexOf("extra-a"));
		expect(text.indexOf("extra-a")).toBeLessThan(text.indexOf("extra-b"));
		expect(text.indexOf("extra-b")).toBeLessThan(text.indexOf("detail"));
	});

	it("hides the expanded line when collapsed and reveals it when expanded", () => {
		const spec: NoticeSpec = { title: "t", why: "w", expandedLine: "only-when-expanded" };
		expect(renderToText(spec)).not.toContain("only-when-expanded");
		expect(renderToText(spec, true)).toContain("only-when-expanded");
	});

	it("routes the title tone to theme.fg and defaults to accent", () => {
		const titleText = "[1mtoned[22m";
		expect(rawRender({ title: "toned", tone: "warning", why: "w" })).toContain(theme.fg("warning", titleText));
		expect(rawRender({ title: "toned", why: "w" })).toContain(theme.fg("accent", titleText));
	});

	it("wraps a 134-char why at width 80 so every visible row fits and the full text is present", () => {
		const why =
			"New version 5.0.0-0.beta.51 is available. Run bun add --cwd '/Users/bitcosgo/.bun/install/global/node_modules/omo-ai' -g omo-ai@beta x";
		expect(why.length).toBe(134);

		const rows = buildNoticeBox({ title: "Update Available", why }, { expanded: false }, theme).render(80);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(80);
		}

		const present = rows.map((row) => row.replace(ANSI_PATTERN, "").trim()).join(" ");
		expect(present.replace(/\s+/g, " ")).toContain(why);
	});
});

describe("noticeMessageRenderer", () => {
	it("returns undefined when the mapper declines the message", () => {
		const renderer = noticeMessageRenderer((message: CustomMessage<Marker>) =>
			message.details === undefined ? undefined : { title: message.details.marker, why: "w" },
		);
		expect(renderer(noticeMessage(undefined), { expanded: false, outputPad: 1 }, theme)).toBeUndefined();
	});

	it("renders the mapped spec through the shared box", () => {
		const renderer = noticeMessageRenderer((message: CustomMessage<Marker>) => {
			if (message.details === undefined) return undefined;
			return { title: `title ${message.details.marker}`, why: "w" };
		});
		const component = renderer(noticeMessage({ marker: "M1" }), { expanded: false, outputPad: 1 }, theme);
		const text = (component?.render(100) ?? []).join("\n").replace(ANSI_PATTERN, "");
		expect(text).toContain("title M1");
	});
});

describe("noticeEntryRenderer", () => {
	it("returns undefined when the mapper declines the entry", () => {
		const renderer = noticeEntryRenderer((entry: CustomEntry<Marker>) =>
			entry.data === undefined ? undefined : { title: entry.data.marker, why: "w" },
		);
		expect(renderer(noticeEntry(undefined), { expanded: false }, theme)).toBeUndefined();
	});

	it("passes the expanded option through to the box", () => {
		const renderer = noticeEntryRenderer((entry: CustomEntry<Marker>) => {
			if (entry.data === undefined) return undefined;
			return { title: entry.data.marker, why: "w", expandedLine: `detail ${entry.data.marker}` };
		});
		const collapsed = renderer(noticeEntry({ marker: "E1" }), { expanded: false }, theme);
		const expanded = renderer(noticeEntry({ marker: "E1" }), { expanded: true }, theme);
		const collapsedText = (collapsed?.render(100) ?? []).join("\n").replace(ANSI_PATTERN, "");
		const expandedText = (expanded?.render(100) ?? []).join("\n").replace(ANSI_PATTERN, "");
		expect(collapsedText).not.toContain("detail E1");
		expect(expandedText).toContain("detail E1");
	});
});
