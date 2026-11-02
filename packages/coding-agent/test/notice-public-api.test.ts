import { describe, expect, test } from "vitest";
import {
	buildNoticeBox,
	type NoticeLine,
	type NoticeSpec,
	type NoticeTone,
	noticeEntryRenderer,
	noticeMessageRenderer,
} from "../src/index.ts";

describe("public notice API", () => {
	test("exports notice primitives and types from the package entry", () => {
		expect(buildNoticeBox).toBeTypeOf("function");
		expect(noticeMessageRenderer).toBeTypeOf("function");
		expect(noticeEntryRenderer).toBeTypeOf("function");

		const tone: NoticeTone = "warning";
		const line: NoticeLine = { text: "detail", tone };
		const spec: NoticeSpec = { title: "Notice", why: "Reason", extra: [line] };
		expect(spec.extra).toEqual([line]);
	});
});
