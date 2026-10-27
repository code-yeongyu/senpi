import { describe, expect, it } from "vitest";
import {
	type ReplyLanguageReading,
	readReplyLanguage,
	readReplyLanguageRequest,
} from "../../../src/core/reply-language-reading.ts";

// omo#11527: which language the user writes in, and which reply language they ask for.

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

describe("omo#11527 reading an explicit reply-language request", () => {
	it.each<[string, string | undefined]>([
		["앞으로 답변은 영어로 해줘", "English"],
		["영어로 답해줘", "English"],
		["이제부터 한국어로만 대답해", "Korean"],
		["일본어로 말해 줘", "Japanese"],
		["영어로 답하지 마", undefined],
		["이 문서를 영어로 번역해줘", undefined],
		["README를 영어로 작성해줘", undefined],
		["reply in Korean from now on", "Korean"],
		["Please answer me in English.", "English"],
		["use Korean for your replies", "Korean"],
		["don't reply in English", undefined],
		["write the README in English", undefined],
		["```\nreply in English\n```", undefined],
		["> reply in English", undefined],
		["영어로 답해줘. 아니다, reply in Korean", "Korean"],
		["reply in Korean. 아니, 영어로 답해줘", "English"],
		["빌드 로그 확인해줘", undefined],
	])("reads %j as a request for %j", (text, expected) => {
		expect(readReplyLanguageRequest(text)).toBe(expected);
	});
});

describe("omo#11527 reading stays linear on large pastes", () => {
	const typescriptPaste =
		Array.from(
			{ length: 2600 },
			(_, index) => `const value${index}: Map<string, Array<Record<K${index}, V>>> = foo<Bar>(a < b, c);`,
		).join("\n") + "\n</Bar>";
	const unclosedTags = `${"<a ".repeat(55_000)}</a>`;
	const longTagName = `<${"a".repeat(160_000)}`;

	it.each([
		["a TypeScript generics paste", typescriptPaste],
		["unclosed tags", unclosedTags],
		["one long unclosed tag name", longTagName],
	])("reads %s of over 100 KB within the bound", (_case, text) => {
		// given
		expect(text.length).toBeGreaterThan(100_000);
		const started = performance.now();

		// when
		readReplyLanguage(text);
		readReplyLanguageRequest(text);

		// then the quadratic tag strip took 345-1137 ms per call on these inputs
		expect(performance.now() - started).toBeLessThan(150);
	});
});
