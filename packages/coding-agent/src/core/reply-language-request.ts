import { QUOTE_MARK, withoutTaggedBlocks } from "./user-prose.ts";

/**
 * An explicit reply-language request (omo#11527). A message has a request only when, after fenced
 * code and tagged blocks are removed, it is ONE non-empty line of at most 120 characters whose
 * sentence is the directive ("영어로 답해줘", "please reply in Korean from now on"), optionally after a
 * few lead words, and the line has no mark of reported speech: no quotation mark, speaker prefix,
 * dash attribution, header or attribution verb. Any message of several lines has no request: four
 * review rounds showed that pasted or reported content across lines cannot be told apart by a list
 * of markers, a wrong request is sticky (it outranks the user's language and survives compaction),
 * and a missed one only costs the note. A directive inside a longer message is ignored by design.
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

/** A message with a request is one line of at most this many characters. */
const MAX_REQUEST_CHARS = 120;

/** Anything that marks reported speech; one match means the line is not the user's own directive. */
const REPORTED_CONTENT: readonly RegExp[] = [
	/[:：]\s*$/m,
	/^\s*[^\s:：][^:：\n]{0,30}[:：]\s*\S/m,
	/^\s*>/m,
	QUOTE_MARK,
	/-{2,}\s*(?:forwarded|original)\b|\b(?:forwarded message|original message)\b|^\s*(?:from|sent|to|subject|date)\s*[:：]|전달된\s*메시지|원본\s*메시지|원문/im,
	/\b(?:said|says|wrote|writes|asked|asks|told|tells|replied|commented|quoted|mentioned|mentions|according to)\b|라고|이라고|말했|말하길|말씀하셨|말씀하시길|요청하셨|그러시|썼|적었|했대|하래|하랬|달래|하더라|하네|그러더라|그랬|에\s*따르면/i,
	/[—–]|(?:^|\s)-{1,2}\s*\p{L}/u,
];

function withoutFencedCode(text: string): string {
	return text
		.split("```")
		.filter((_, index) => index % 2 === 0)
		.join("\n");
}

function languageOf(name: string): string | undefined {
	return (
		KOREAN_NAME_TO_LANGUAGE.get(name) ??
		REQUESTABLE_LANGUAGE_NAMES.find((language) => language.toLowerCase() === name.toLowerCase())
	);
}

/** The language the last whole-sentence directive on a line asks for. */
function lineDirective(line: string): string | undefined {
	let requested: string | undefined;
	for (const sentence of line.split(/[.!?。！？~]+/)) {
		const trimmed = sentence.trim();
		for (const directive of DIRECTIVES) {
			const name = directive.exec(trimmed)?.[1];
			if (name !== undefined) requested = languageOf(name) ?? requested;
		}
	}
	return requested;
}

/** The reply language the user explicitly asks for, if the whole message is a one-line directive. */
export function readReplyLanguageRequest(text: string): string | undefined {
	const message = withoutFencedCode(withoutTaggedBlocks(text)).trim();
	const lines = message.split("\n").filter((line) => line.trim() !== "");
	const line = lines[0];
	if (line === undefined || lines.length > 1 || line.trim().length > MAX_REQUEST_CHARS) return undefined;
	if (REPORTED_CONTENT.some((marker) => marker.test(line))) return undefined;
	return lineDirective(line);
}
