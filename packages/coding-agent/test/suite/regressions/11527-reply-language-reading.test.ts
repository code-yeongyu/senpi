import { describe, expect, it } from "vitest";
import { type ReplyLanguageReading, readReplyLanguage } from "../../../src/core/reply-language-reading.ts";
import { type ProseScan, withoutTaggedBlocks } from "../../../src/core/user-prose.ts";

// omo#11527: which language the user writes their own words in.

const KOREAN: ReplyLanguageReading = { kind: "language", language: "Korean" };
const LATIN: ReplyLanguageReading = { kind: "latin" };

describe("omo#11527 reading the user's own language", () => {
	it.each<[string, ReplyLanguageReading]>([
		["아직이야? 얼마나 진행됐어", KOREAN],
		["PR #123 리뷰해줘 bundle-inputs check도 돌려", KOREAN],
		["PR #4540\n리뷰해줘", KOREAN],
		["<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>\n고쳐줘", KOREAN],
		["이거 봐줘\nThe build failed because the lease file was not flushed before replay started.", KOREAN],
		["Error: ENOENT no such file\n    at open (fs.js:1:1)\n이거 왜 나?", KOREAN],
		["why does this fail?\n파일을 찾을 수 없습니다. 경로를 다시 확인하세요.", LATIN],
		["why does this fail?\n오류: 파일을 찾을 수 없습니다", LATIN],
		["can you check this?\n> 빌드가 실패했습니다 다시 시도해 주세요", LATIN],
		['what does "빌드가 실패했습니다 다시 시도" mean here?', LATIN],
		["what does “빌드가 실패했습니다 다시 시도” mean here?", LATIN],
		["what does 「빌드가 실패했습니다 다시 시도」 mean here?", LATIN],
		["빌드가 실패했습니다 다시 시도해줘", KOREAN],
		['"build failed" 이게 무슨 뜻이야?', KOREAN],
		["please translate 안녕 into English for the greeting screen", LATIN],
		["corrige ce test s'il te plaît", LATIN],
		["このテストを直してください", { kind: "language", language: "Japanese" }],
		["帮我看一下这个测试为什么失败", { kind: "language", language: "Chinese" }],
		["Почини этот тест, пожалуйста", { kind: "language", language: "Cyrillic script" }],
		["```\n빌드 실패\n```", { kind: "none" }],
		["`빌드 실패` https://example.com/한국어", { kind: "none" }],
	])("reads %j as %j", (text, expected) => {
		expect(readReplyLanguage(text)).toEqual(expected);
	});
});

describe("omo#11527 reading stays linear on large pastes", () => {
	const typescriptPaste = `${Array.from(
		{ length: 2600 },
		(_, index) => `const value${index}: Map<string, Array<Record<K${index}, V>>> = foo<Bar>(a < b, c);`,
	).join("\n")}\n</Bar>`;
	const unclosedTags = `${"<a ".repeat(55_000)}</a>`;
	const longTagName = `<${"a".repeat(160_000)}></${"a".repeat(10)}>`;

	it.each([
		["a TypeScript generics paste", typescriptPaste],
		["unclosed tags", unclosedTags],
		["one long unclosed tag name", longTagName],
	])("visits each character of %s a bounded number of times", (_case, text) => {
		// given
		expect(text.length).toBeGreaterThan(100_000);
		const scan: ProseScan = { steps: 0 };

		// when
		withoutTaggedBlocks(text, scan);

		// then a rescanning strip visits each character once per unclosed tag
		expect(scan.steps).toBeGreaterThan(0);
		expect(scan.steps).toBeLessThanOrEqual(3 * text.length);
	});
});
