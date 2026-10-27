import { isPastedLine, QUOTE_MARK, userProse } from "./user-prose.ts";

/**
 * An explicit reply-language request (omo#11527). Only the user's own directive to the agent counts:
 * a short sentence that is nothing but the request, at the start of the user's own line, optionally
 * after a few lead words ("앞으로", "please"). Reported speech never counts: a sentence with any
 * quotation mark, a line with a speaker prefix ("User:", "he wrote:"), a line after an attribution
 * ("라고 했", "said"), or a line inside a pasted block of several lines. When in doubt it is not a
 * request: a missed request only costs the note, a false one would override the user's language.
 */

/** Languages a user can ask for by name, with their Korean names. */
const REQUESTABLE_LANGUAGES: Record<string, readonly string[]> = {
	English: ["영어"],
	Korean: ["한국어", "한글"],
	Japanese: ["일본어"],
	Chinese: ["중국어"],
	French: ["프랑스어", "불어"],
	German: ["독일어"],
	Spanish: ["스페인어"],
	Russian: ["러시아어"],
	Portuguese: ["포르투갈어"],
	Italian: ["이탈리아어"],
	Vietnamese: ["베트남어"],
	Thai: ["태국어"],
};

export const REQUESTABLE_LANGUAGE_NAMES: readonly string[] = Object.keys(REQUESTABLE_LANGUAGES);

const KOREAN_NAME_TO_LANGUAGE = new Map(
	Object.entries(REQUESTABLE_LANGUAGES).flatMap(([language, names]) => names.map((name) => [name, language] as const)),
);
const KOREAN_NAMES = [...KOREAN_NAME_TO_LANGUAGE.keys()].join("|");
const ENGLISH_NAMES = REQUESTABLE_LANGUAGE_NAMES.join("|");

const LEAD_WORDS =
	"앞으로|이제|이제부터|지금부터|다음부터|그리고|그럼|그냥|혹시|제발|꼭|아니|아니다|아니요|아뇨|음|자|ok|okay|please|and|also|so|now|no|wait|actually|from now on";
const LEAD = `^(?:(?:${LEAD_WORDS})\\s*,?\\s*)*`;
const KOREAN_ENDING =
	"(?:해|해줘|해 줘|해주세요|해 주세요|해줄래|해요|하세요|해라|하자|해주라|해주시겠어요|부탁해|부탁해요|부탁드려요|부탁합니다)";
const KOREAN_REPLY_NOUN = "(?:답변|대답|응답|답장)";

/** Each pattern spans the whole sentence; group 1 is the language. */
const DIRECTIVES: readonly RegExp[] = [
	new RegExp(
		`${LEAD}${KOREAN_REPLY_NOUN}\\s*(?:은|는|도|을)?\\s*(?:앞으로|이제|전부|모두|다)?\\s*(${KOREAN_NAMES})\\s*(?:으로|로)\\s*(?:만|좀)?\\s*${KOREAN_ENDING}$`,
	),
	new RegExp(
		`${LEAD}(${KOREAN_NAMES})\\s*(?:으로|로)\\s*(?:만|좀)?\\s*(?:답변|대답|응답|답장|답|말|얘기|이야기|소통)\\s*(?:을|좀)?\\s*${KOREAN_ENDING}$`,
	),
	new RegExp(
		`${LEAD}(?:(?:can|could|would|will) you\\s+)?(?:please\\s+)?(?:reply|respond|answer|talk|speak|communicate|chat)(?:\\s+(?:to me|me|back))?\\s+(?:only\\s+)?in\\s+(${ENGLISH_NAMES})(?:\\s*,?\\s*(?:from now on|please|only|going forward|for now|from here on))*$`,
		"i",
	),
	new RegExp(
		`${LEAD}(?:please\\s+)?use\\s+(${ENGLISH_NAMES})\\s+(?:only\\s+)?(?:from now on|for (?:your |all )?(?:replies|responses|answers))(?:\\s*,?\\s*please)?$`,
		"i",
	),
];

/** "Name:" or "he wrote:" at the start of a line: the rest of the line is someone else's words. */
const SPEAKER_PREFIX = /^\s*[^:\n]{1,30}:\s/;

/** Reported speech: after this, nothing on the line is the user's own directive. */
const ATTRIBUTION =
	/\b(?:said|says|wrote|writes|asked|asks|told|tells|replied|commented|quoted)\b|라고|말했|말하길|썼|적었|했대|하더라|하네|그러더라|그랬/i;

/** A paragraph with more lines than this reads as a paste, not as the user's own request. */
const MAX_OWN_PARAGRAPH_LINES = 3;

/** A longer line is a paste or a long message, not a short directive. */
const MAX_DIRECTIVE_LINE_CHARS = 200;

function languageOf(name: string): string | undefined {
	return (
		KOREAN_NAME_TO_LANGUAGE.get(name) ??
		REQUESTABLE_LANGUAGE_NAMES.find((language) => language.toLowerCase() === name.toLowerCase())
	);
}

/** The requested language a line's sentences establish (the last directive wins). */
function lineRequest(line: string): string | undefined {
	if (line.length > MAX_DIRECTIVE_LINE_CHARS || SPEAKER_PREFIX.test(line) || isPastedLine(line)) return undefined;
	let requested: string | undefined;
	for (const sentence of line.split(/[.!?。！？~]+/)) {
		const trimmed = sentence.trim();
		if (ATTRIBUTION.test(trimmed)) return undefined;
		if (trimmed === "" || QUOTE_MARK.test(trimmed)) continue;
		for (const directive of DIRECTIVES) {
			const name = directive.exec(trimmed)?.[1];
			if (name !== undefined) requested = languageOf(name) ?? requested;
		}
	}
	return requested;
}

/** The reply language the user explicitly asks for in this message (the last request wins). */
export function readReplyLanguageRequest(text: string): string | undefined {
	let requested: string | undefined;
	for (const paragraph of userProse(text).split(/\n\s*\n/)) {
		const lines = paragraph.split("\n").filter((line) => line.trim() !== "");
		if (lines.length > MAX_OWN_PARAGRAPH_LINES) continue;
		for (const line of lines) requested = lineRequest(line) ?? requested;
	}
	return requested;
}
