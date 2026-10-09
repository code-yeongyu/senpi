export function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state;
	};
}

const ONSETS = "b,br,c,ch,d,dr,f,fl,g,gl,h,j,k,l,m,n,p,pl,qu,r,s,sh,t,tr,v,w".split(",");
const RIMES =
	"ade,ane,ark,eal,ean,eed,ell,ent,ess,ift,ilm,ind,ock,oil,old,ond,oom,ore,orn,ount,ove,udge,ule,urn,ust,yle".split(
		",",
	);

export const HEALTHY_WORD_COUNT = 26 * 26;

export function healthyWord(index: number): string {
	const onset = ONSETS[index % ONSETS.length] ?? "s";
	const rime = RIMES[Math.floor(index / ONSETS.length) % RIMES.length] ?? "ore";
	return `${onset}${rime}`;
}

export function buildHealthyPrefix(targetLength: number): string {
	const parts: string[] = [];
	const next = lcg(97);
	let length = 0;
	let index = 0;
	while (length < targetLength) {
		const pick = () => healthyWord(next() % (ONSETS.length * RIMES.length));
		const sentence = `The ${pick()} near the ${pick()} keeps ${pick()} aligned with ${pick()} while ${pick()} settles into ${pick()}.`;
		parts.push(sentence);
		length += sentence.length + 1;
		if (index % 10 === 9) {
			parts.push("\n\n");
			length += 2;
		}
		index += 1;
	}
	return parts.join(" ");
}

export function buildMarkdownRules(): string {
	const lengths = [3, 5, 8, 13, 21, 34, 55, 89, 120, 60, 41, 25, 9, 17, 72, 110, 47, 99];
	const parts: string[] = [];
	let index = 0;
	for (const length of lengths) {
		parts.push("-".repeat(length));
		parts.push(`Rule ${index} above separates section ${index} of the document body text.`);
		index += 1;
	}
	return `${parts.join("\n")}\n`;
}

export function buildAsciiArt(): string {
	const rows: string[] = [];
	rows.push(`+${"-".repeat(38)}+`);
	for (let i = 0; i < 20; i++) {
		const fill = i % 2 === 0 ? "/" : "\\";
		const fillCount = i % 7;
		rows.push(`|${fill.repeat(fillCount)}${" ".repeat(38 - fillCount)}|`);
	}
	for (let i = 0; i < 4; i++) rows.push(`|${" ".repeat(38)}|`);
	rows.push(`+${"-".repeat(38)}+`);
	return `${rows.join("\n")}\n`;
}

export function buildBoxTable(): string {
	const horizontal = "─".repeat(18);
	const rows: string[] = [];
	rows.push(`┌${horizontal}┬${horizontal}┐`);
	for (let i = 0; i < 24; i++) {
		const name = `row ${i}`.padEnd(16, " ");
		const value = `value ${i * 13}`.padEnd(16, " ");
		rows.push(`│ ${name} │ ${value} │`);
		if (i % 3 === 2) rows.push(`├${horizontal}┼${horizontal}┤`);
	}
	rows.push(`└${horizontal}┴${horizontal}┘`);
	return `${rows.join("\n")}\n`;
}

export function buildBase64(targetLength: number, seed: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const next = lcg(seed);
	let out = "";
	while (out.length < targetLength) out += alphabet.charAt(next() % 64);
	return out;
}

export function buildMinifiedJs(targetLength: number): string {
	let out = "";
	let index = 0;
	while (out.length < targetLength) {
		out += `function f${index}(a,b){var r=a*${index % 97}+b;if(r>${index % 61}){r=r/(1+${index % 7})}return r}`;
		index += 1;
	}
	return out;
}

export function buildSeparatorComments(): string {
	const chars = ["-", "=", "*", "/", "#", "~", "_", "+"];
	const rows: string[] = [];
	for (let i = 0; i < 20; i++) {
		rows.push(`// ${(chars[i % chars.length] ?? "-").repeat(30 + i * 11)}`);
	}
	return `${rows.join("\n")}\n`;
}

export function buildCjkArticle(targetLength: number, seed: number): string {
	const next = lcg(seed);
	const punctuation = ["。", "、", "，", "；"];
	let out = "";
	while (out.length < targetLength) {
		out += String.fromCharCode(0x4e00 + (next() % 0x600));
		if (out.length % 17 === 0) out += punctuation[next() % punctuation.length] ?? "。";
		if (out.length % 121 === 0) out += "\n\n";
	}
	return out;
}

export const AP1_PREFIX = "Let me think through this problem carefully before answering the question. ";
export const AP9_LINE = "The quick brown fox jumps over the lazy dog while the birds sing".padEnd(72, ".");
export const AP10_LINE_A = "First alternating row carries the alpha".padEnd(40, ".");
export const AP10_LINE_B = "Second alternating row carries the beta".padEnd(40, ".");
export const AN11_LINE = "A repeated prose line that stays under the cycle threshold".padEnd(100, ".");
export const AP12_PREFIX = buildHealthyPrefix(300 * 1024);
