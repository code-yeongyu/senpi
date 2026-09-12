const SYMBOLS: Readonly<Record<string, string>> = {
	"\\aleph": "ℵ",
	"\\alpha": "α",
	"\\approx": "≈",
	"\\beta": "β",
	"\\bowtie": "⋈",
	"\\cdot": "·",
	"\\chi": "χ",
	"\\Delta": "Δ",
	"\\delta": "δ",
	"\\div": "÷",
	"\\epsilon": "ϵ",
	"\\equiv": "≡",
	"\\eta": "η",
	"\\exists": "∃",
	"\\forall": "∀",
	"\\fullouterjoin": "⟗",
	"\\Gamma": "Γ",
	"\\gamma": "γ",
	"\\ge": "≥",
	"\\geq": "≥",
	"\\in": "∈",
	"\\infty": "∞",
	"\\int": "∫",
	"\\iota": "ι",
	"\\Join": "⋈",
	"\\kappa": "κ",
	"\\Lambda": "Λ",
	"\\lambda": "λ",
	"\\le": "≤",
	"\\leftarrow": "←",
	"\\leftouterjoin": "⟕",
	"\\leftrightarrow": "↔",
	"\\leq": "≤",
	"\\ltimes": "⋉",
	"\\mu": "μ",
	"\\nabla": "∇",
	"\\ne": "≠",
	"\\neq": "≠",
	"\\ni": "∋",
	"\\notin": "∉",
	"\\nu": "ν",
	"\\Omega": "Ω",
	"\\omega": "ω",
	"\\otimes": "⊗",
	"\\partial": "∂",
	"\\Phi": "Φ",
	"\\phi": "ϕ",
	"\\Pi": "Π",
	"\\pi": "π",
	"\\pm": "±",
	"\\prod": "∏",
	"\\Psi": "Ψ",
	"\\psi": "ψ",
	"\\rho": "ρ",
	"\\rightarrow": "→",
	"\\rightouterjoin": "⟖",
	"\\rtimes": "⋊",
	"\\Sigma": "Σ",
	"\\sigma": "σ",
	"\\sim": "∼",
	"\\subset": "⊂",
	"\\subseteq": "⊆",
	"\\sum": "∑",
	"\\supset": "⊃",
	"\\supseteq": "⊇",
	"\\tau": "τ",
	"\\Theta": "Θ",
	"\\theta": "θ",
	"\\times": "×",
	"\\to": "→",
	"\\Upsilon": "Υ",
	"\\upsilon": "υ",
	"\\varepsilon": "ε",
	"\\varphi": "φ",
	"\\vartheta": "ϑ",
	"\\xi": "ξ",
	"\\zeta": "ζ",
};

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
	"0": "⁰",
	"1": "¹",
	"2": "²",
	"3": "³",
	"4": "⁴",
	"5": "⁵",
	"6": "⁶",
	"7": "⁷",
	"8": "⁸",
	"9": "⁹",
	"+": "⁺",
	"-": "⁻",
	"=": "⁼",
	"(": "⁽",
	")": "⁾",
	i: "ⁱ",
	n: "ⁿ",
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
	"0": "₀",
	"1": "₁",
	"2": "₂",
	"3": "₃",
	"4": "₄",
	"5": "₅",
	"6": "₆",
	"7": "₇",
	"8": "₈",
	"9": "₉",
	"+": "₊",
	"-": "₋",
	"=": "₌",
	"(": "₍",
	")": "₎",
	a: "ₐ",
	e: "ₑ",
	h: "ₕ",
	i: "ᵢ",
	j: "ⱼ",
	k: "ₖ",
	l: "ₗ",
	m: "ₘ",
	n: "ₙ",
	o: "ₒ",
	p: "ₚ",
	r: "ᵣ",
	s: "ₛ",
	t: "ₜ",
	u: "ᵤ",
	v: "ᵥ",
	x: "ₓ",
};

const MAX_FORMULA_LENGTH = 4096;
const MAX_NESTING_DEPTH = 64;
const LEADING_COMBINING_MARK_REGEX = /^\p{Mark}/u;
const STYLE_COMMANDS = new Set(["\\mathrm", "\\mathbf", "\\mathit", "\\text", "\\operatorname"]);

const scriptText = (text: string, alphabet: Readonly<Record<string, string>>): string | undefined => {
	let output = "";
	for (const character of text) {
		const replacement = alphabet[character];
		if (replacement === undefined) return undefined;
		output += replacement;
	}
	return output;
};

class LatexParser {
	private index = 0;
	private readonly input: string;

	constructor(input: string) {
		this.input = input;
	}

	parse(): string | undefined {
		const output = this.parseSequence(0, false);
		return output !== undefined && this.index === this.input.length ? output : undefined;
	}

	private parseSequence(depth: number, stopAtBrace: boolean): string | undefined {
		if (depth > MAX_NESTING_DEPTH) return undefined;
		const output: string[] = [];
		while (this.index < this.input.length) {
			const character = this.input[this.index];
			if (character === "}" && stopAtBrace) return output.join("");
			if (character === "\\") {
				const command = this.parseCommand(depth);
				if (command === undefined) return undefined;
				output.push(command);
				continue;
			}
			if (character === "^" || character === "_") {
				const script = this.parseScript(character, depth);
				if (script === undefined) return undefined;
				output.push(script);
				continue;
			}
			if (character === "{") {
				const group = this.parseGroup(depth);
				if (group === undefined) return undefined;
				output.push(group);
				continue;
			}
			output.push(character ?? "");
			this.index += 1;
		}
		return stopAtBrace ? undefined : output.join("");
	}

	private parseGroup(depth: number): string | undefined {
		if (this.input[this.index] !== "{") return undefined;
		this.index += 1;
		const body = this.parseSequence(depth + 1, true);
		if (body === undefined || this.input[this.index] !== "}") return undefined;
		this.index += 1;
		return body;
	}

	private parseCommand(depth: number): string | undefined {
		this.index += 1;
		const first = this.input[this.index];
		if (first === undefined) return "\\";
		if (!/[A-Za-z]/.test(first)) {
			this.index += 1;
			if ("_^{}[]()$%&#".includes(first)) return first;
			if (first === "!") return "";
			if (",;:".includes(first)) return " ";
			return `\\${first}`;
		}

		const start = this.index;
		while (/[A-Za-z]/.test(this.input[this.index] ?? "")) this.index += 1;
		const command = `\\${this.input.slice(start, this.index)}`;
		const symbol = SYMBOLS[command];
		if (symbol !== undefined) return symbol;
		if (STYLE_COMMANDS.has(command)) {
			this.skipSpaces();
			return this.input[this.index] === "{" ? this.parseGroup(depth) : command;
		}
		if (command === "\\sqrt") {
			this.skipSpaces();
			const body = this.parseGroup(depth);
			return body === undefined ? undefined : `√(${body})`;
		}
		if (command === "\\frac") {
			this.skipSpaces();
			const numerator = this.parseGroup(depth);
			this.skipSpaces();
			const denominator = numerator === undefined ? undefined : this.parseGroup(depth);
			return numerator === undefined || denominator === undefined ? undefined : `(${numerator})⁄(${denominator})`;
		}
		if (command === "\\left" || command === "\\right") {
			this.skipSpaces();
			const delimiter = this.input[this.index];
			if (delimiter === ".") {
				this.index += 1;
				return "";
			}
			const escapedDelimiter = delimiter === "\\" ? this.input[this.index + 1] : undefined;
			if (escapedDelimiter !== undefined && "{}".includes(escapedDelimiter)) {
				this.index += 2;
				return escapedDelimiter;
			}
			if (delimiter !== undefined && "()[]{}|".includes(delimiter)) {
				this.index += 1;
				return delimiter;
			}
		}
		if (command === "\\quad") return "  ";
		let fallback = command;
		const argumentStart = this.index;
		this.skipSpaces();
		if (this.input[this.index] !== "{") this.index = argumentStart;
		while (this.input[this.index] === "{") {
			const group = this.parseGroup(depth);
			if (group === undefined) return undefined;
			fallback += `{${group}}`;
		}
		return fallback;
	}

	private parseScript(marker: "^" | "_", depth: number): string | undefined {
		this.index += 1;
		const alphabet = marker === "^" ? SUPERSCRIPTS : SUBSCRIPTS;
		if (this.input[this.index] === "{") {
			const body = this.parseGroup(depth);
			if (body === undefined) return undefined;
			return scriptText(body, alphabet) ?? `${marker}{${body}}`;
		}
		if (this.input[this.index] === "\\") {
			const body = this.parseCommand(depth);
			if (body === undefined) return undefined;
			return scriptText(body, alphabet) ?? `${marker}${body}`;
		}
		const codePoint = this.input.codePointAt(this.index);
		if (codePoint === undefined) return marker;
		const body = String.fromCodePoint(codePoint);
		this.index += body.length;
		return alphabet[body] ?? `${marker}${body}`;
	}

	private skipSpaces(): void {
		while (this.input[this.index] === " ") this.index += 1;
	}
}

export const latexToUnicode = (formula: string): string => {
	const trimmed = formula.trim();
	let rendered = trimmed;
	if (trimmed.length <= MAX_FORMULA_LENGTH) {
		const normalized = trimmed.replace(/\s+/g, " ");
		rendered = new LatexParser(normalized).parse() ?? trimmed;
	}
	return LEADING_COMBINING_MARK_REGEX.test(rendered) ? `◌${rendered}` : rendered;
};
