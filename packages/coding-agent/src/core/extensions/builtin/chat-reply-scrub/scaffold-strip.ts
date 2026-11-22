// Coding-agent scaffolding that must never reach a chat room (senpi#2398): the Intent Gate routing /
// stop line a terminal prompt asks for ("I read this as ... I'll stop when ..." and its translations),
// handoff blocks (Ask / wanted / For you / Now / Next and their Korean labels) and todo / ledger lines.
// The chat prompt surface stops asking for them; this strip is the last-mile backstop. Same rules as the
// OmO gateway's send-boundary strip, so a reply scrubbed here passes that one unchanged.

const ADDRESS_PREFIX = /^(?:<@[^>\s]+>[:,]?|[^\n,<]{1,40}님,|@[^\s,]{1,40},)[ \t]*/u;

const INTENT_SENTENCE = [
	/^I(?:'m| am)? read(?:ing)? this as\b/i,
	/^I read (?:this|that|your (?:message|request)) as\b/i,
	/(?:요청|질문|말|바람|지시|고민|부탁|뜻|의도|얘기|이야기)(?:으)?로\s*(?:읽었|이해했|받아들였)/u,
	/(?:걸|것으)로\s*(?:읽었|이해했)/u,
	/^(?:이건|이거|이번 건|이 (?:말|요청|질문|메시지)[은는]|(?:요청|질문|메시지)[을를])\s.*(?:으)?로\s*(?:읽었|이해했)/u,
];

const STOP_SENTENCE = [
	/\bI'?ll stop (?:when|once|after)\b/i,
	/\bI will stop (?:when|once|after)\b/i,
	/멈출\s*조건/u,
	/여기서\s*(?:멈출|마칠|끝낼|멈추|마치)/u,
	/(?:멈출|마칠|끝낼)게(?:요)?[.!]?$/u,
	/(?:보내|전달하|답하)면\s*(?:끝|마무리)/u,
];

// "... 답할게." between an intent sentence and a stop sentence is the routing line's [plan] part.
const PLAN_SENTENCE = /(?:할|줄|드릴|볼|답할|정리할|설명할|알려줄|알려드릴)게(?:요)?[.!]?$/u;

const HANDOFF_LABEL =
	/^\s*(?:>\s*)?(?:\*{1,2})?(?:Ask|wanted|For you|Now|Next|You need|최초\s*의도|원했던\s*것|궁금해할\s*정보|지금\s*집중하는\s*것|다음\s*계획)(?:\*{1,2})?\s*[:：]/iu;
// A handoff block opens with Ask / wanted / For you (or the Korean opening labels); Now: / Next:
// lines alone are an ordinary plan, and a lone labelled line is answer text.
const HANDOFF_OPENING =
	/^\s*(?:>\s*)?(?:\*{1,2})?(?:Ask|wanted|For you|최초\s*의도|원했던\s*것|궁금해할\s*정보)(?:\*{1,2})?\s*[:：]/iu;
const HANDOFF_SIGNATURE = [
	/\bAsk\s*[:：].*\s-\s*wanted\s*[:：]/iu,
	/\bFor you\s*[:：].*\bNow\s*[:：].*\bNext\s*[:：]/iu,
];

// Ledger lines count only inside a ledger block: next to a todo-tool marker or a handoff block.
const LEDGER_MARKER = [/^\s*(?:Overall|Remaining items|Active phase)\b.*\d/iu, /\bledger\s+\d+\s*\/\s*\d+/iu];
const LEDGER_ITEM = [
	/^\s*[-*]\s*\[[ xX]\]\s/u,
	/^\s*[-*]\s.*\[(?:pending|in_progress|completed|done|dropped)\]/iu,
	/^\s*(?:Todo|TODO|To-do|Ledger|투두|할\s*일\s*목록|렛져|레저)\s*[:：]/u,
];

export interface ScaffoldStrip {
	readonly text: string;
	readonly removed: readonly string[];
	readonly empty: boolean;
}

type LineKind = "handoff" | "ledger";

const matchesAny = (patterns: readonly RegExp[], line: string): boolean =>
	patterns.some((pattern) => pattern.test(line));
const isIntent = (sentence: string): boolean => matchesAny(INTENT_SENTENCE, sentence);
const isStop = (sentence: string): boolean => matchesAny(STOP_SENTENCE, sentence);

function sentencesOf(paragraph: string): string[] {
	return paragraph
		.split(/(?<=[.!?。])\s+/u)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0);
}

function leadingRoutingCount(sentences: readonly string[]): number {
	const first = sentences[0];
	if (first === undefined || !(isIntent(first) || isStop(first))) return 0;
	let end = 0;
	for (let index = 0; index < sentences.length; index += 1) {
		const sentence = sentences[index] ?? "";
		if (isIntent(sentence) || isStop(sentence)) {
			end = index + 1;
			continue;
		}
		if (index === end && PLAN_SENTENCE.test(sentence) && sentences.slice(index + 1).some(isStop)) continue;
		break;
	}
	return end;
}

function classifyLines(lines: readonly string[]): (LineKind | null)[] {
	const kinds: (LineKind | null)[] = lines.map((line) => (matchesAny(HANDOFF_SIGNATURE, line) ? "handoff" : null));
	for (let index = 0; index < lines.length; ) {
		let end = index;
		while (end < lines.length && HANDOFF_LABEL.test(lines[end] ?? "")) end += 1;
		const opens = lines.slice(index, end).some((line) => HANDOFF_OPENING.test(line));
		if (end - index >= 2 && opens) for (let at = index; at < end; at += 1) kinds[at] = "handoff";
		index = Math.max(end, index + 1);
	}
	for (let index = 0; index < lines.length; ) {
		let end = index;
		while (end < lines.length && (lines[end] ?? "").trim() !== "") end += 1;
		const block = lines.slice(index, end);
		const isLedgerBlock = block.some(
			(line, at) => matchesAny(LEDGER_MARKER, line) || kinds[index + at] === "handoff",
		);
		if (isLedgerBlock) {
			block.forEach((line, at) => {
				if (kinds[index + at] === null && (matchesAny(LEDGER_MARKER, line) || matchesAny(LEDGER_ITEM, line))) {
					kinds[index + at] = "ledger";
				}
			});
		}
		index = end + 1;
	}
	return kinds;
}

export function stripAgentScaffold(input: string): ScaffoldStrip {
	const removed: string[] = [];
	const normalized = input.replace(/\r\n?/g, "\n").trim();
	const prefix = ADDRESS_PREFIX.exec(normalized)?.[0] ?? "";
	const all = normalized.slice(prefix.length).split("\n");
	const kinds = classifyLines(all);
	const lines = all.filter((line, index) => {
		const kind = kinds[index];
		if (kind === null || kind === undefined) return true;
		removed.push(`${kind}: ${line.trim()}`);
		return false;
	});

	const first = lines.findIndex((line) => line.trim().length > 0);
	if (first >= 0) {
		const sentences = sentencesOf(lines[first] ?? "");
		const count = leadingRoutingCount(sentences);
		if (count > 0) {
			removed.push(...sentences.slice(0, count).map((sentence) => `routing: ${sentence}`));
			lines[first] = sentences.slice(count).join(" ");
		}
	}

	if (removed.length === 0) return { text: input, removed, empty: false };
	const body = lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const empty = !/[\p{L}\p{N}]/u.test(body);
	return { text: empty ? "" : `${prefix}${body}`, removed, empty };
}
