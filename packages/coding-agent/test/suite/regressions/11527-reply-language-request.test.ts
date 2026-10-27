import { describe, expect, it } from "vitest";
import { readReplyLanguageRequest } from "../../../src/core/reply-language-request.ts";

// omo#11527: a reply-language request is decided for the whole message: only a short message whose
// first or last line is the user's own directive has one; any sign of reported speech or pasted
// content anywhere in the message (quotes, attribution, speaker label, header, paste) means none.

const DIRECTIVES = [
	["Korean directive", "영어로 답해줘"],
	["English directive", "reply in English"],
] as const;

const QUOTE_STYLES = [
	["ASCII double quotes", (text: string) => `"${text}"`],
	["ASCII single quotes", (text: string) => `'${text}'`],
	["curly double quotes", (text: string) => `“${text}”`],
	["curly single quotes", (text: string) => `‘${text}’`],
	["corner brackets", (text: string) => `「${text}」`],
	["white corner brackets", (text: string) => `『${text}』`],
	["guillemets", (text: string) => `«${text}»`],
	["backticks", (text: string) => `\`${text}\``],
] as const;

describe("omo#11527 a reply-language request is the user's own directive only", () => {
	describe.each(DIRECTIVES)("%s", (_name, directive) => {
		it("counts on the user's own line (positive control)", () => {
			expect(readReplyLanguageRequest(`이거 봐줘\n${directive}`)).toBe("English");
		});

		it.each(QUOTE_STYLES)("does not count inside %s, alone or after the user's words", (_style, quote) => {
			expect(readReplyLanguageRequest(quote(directive))).toBeUndefined();
			expect(readReplyLanguageRequest(`이 메시지 왜 이래?\n${quote(directive)}`)).toBeUndefined();
			expect(readReplyLanguageRequest(`what does ${quote(directive)} mean?`)).toBeUndefined();
		});

		it.each([
			["a speaker prefix", `User: ${directive}`],
			["a Korean speaker prefix", `민지: ${directive}`],
			["an English attribution with a colon", `he wrote: ${directive}. 고쳐줘`],
			["a block quote", `> ${directive}`],
			["a fenced block", `\`\`\`\n${directive}\n\`\`\``],
		])("does not count after %s", (_form, text) => {
			expect(readReplyLanguageRequest(`이거 봐줘\n${text}`)).toBeUndefined();
		});

		it("counts first, then a normal question, in a short message (positive control)", () => {
			expect(readReplyLanguageRequest(`${directive}\n빌드는 왜 실패했어?`)).toBe("English");
		});

		it.each([
			["a Korean label ending its line with a colon", `고객 메시지:\n${directive}`],
			["an English label ending its line with a colon", `The customer wrote:\n${directive}`],
			["a fullwidth colon label", `고객 메시지：\n${directive}`],
			["a forwarded-message header", `---------- Forwarded message ---------\n${directive}`],
			["an original-message header", `-----Original Message-----\n${directive}`],
			["a Korean forwarded header", `전달된 메시지\n${directive}`],
			["a lazy blockquote continuation", `> 고객 메시지\n${directive}`],
			["a mail header line", `From: kim@example.com\n${directive}`],
			["a pasted block of several lines", `참고로 이 로그 봐줘\nline one\n${directive}\nline three`],
			["a paste before the user's own last line", `line one\nline two\nline three\n${directive}`],
			["a long message", `${"빌드 로그를 확인했는데 계속 실패하네요 ".repeat(12)}\n${directive}`],
			["a directive in the middle line", `이거 봐줘\n${directive}\n빌드는 왜 실패했어?`],
		])("does not count after %s", (_form, text) => {
			expect(readReplyLanguageRequest(text)).toBeUndefined();
		});
	});

	it.each<[string, string]>([
		["a Korean attribution with 라고 했어", "그가 영어로 답하라고 했어"],
		["a Korean attribution with 라고 하네", "팀장님이 영어로 답해달라고 하네"],
		["a Korean attribution after the directive", "영어로 답해줘라고 하더라"],
		["a Korean report of what someone did", "고객이 영어로 답해줘라고 했어"],
		["an English attribution with said", "she said reply in English"],
		["an English attribution with says", "The ticket says reply in English"],
		["an English speaker prefix with please", "Customer: reply in English please"],
	])("does not count %s", (_form, text) => {
		expect(readReplyLanguageRequest(text)).toBeUndefined();
	});

	it.each<[string, string | undefined]>([
		["앞으로 답변은 영어로 해줘", "English"],
		["앞으로 답변은 영어로 해줘. 빌드 로그 확인해줘", "English"],
		["이제부터 한국어로만 대답해", "Korean"],
		["일본어로 말해 줘", "Japanese"],
		["reply in Korean from now on", "Korean"],
		["Please answer me in English.", "English"],
		["please reply in Korean from now on", "Korean"],
		["Can you reply in English?", "English"],
		["use Korean for your replies", "Korean"],
		["영어로 답해줘. 아니다, reply in Korean", "Korean"],
		["reply in Korean. 아니, 영어로 답해줘", "English"],
		["영어로 답하지 마", undefined],
		["이 문서를 영어로 번역해줘", undefined],
		["README를 영어로 작성해줘", undefined],
		["don't reply in English", undefined],
		["write the README in English", undefined],
		["I think you should reply in English when the user writes in English", undefined],
		["빌드 로그 확인해줘", undefined],
	])("reads %j as a request for %j", (text, expected) => {
		expect(readReplyLanguageRequest(text)).toBe(expected);
	});
});
