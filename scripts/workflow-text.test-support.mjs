// Read jobs and steps out of a GitHub Actions workflow's text, and evaluate the `${{ }}` expressions a job's `if:` and
// `timeout-minutes:` use, so a test can check what a dispatch actually runs instead of pinning expression text.

/** The text of one job, from its `  <name>:` line to the next job. */
export function workflowJob(workflow, name) {
	const match = workflow.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [A-Za-z][\\w-]*:\\n|$)`));
	if (!match) throw new Error(`no job ${name}`);
	return match[0];
}

/** Every step of a job as `{name, text}`; comment-only lines are dropped and trailing blank lines trimmed. */
export function jobSteps(job) {
	const body = job.slice(job.indexOf("\n    steps:\n"));
	return body
		.split(/\n(?= {6}- )/)
		.slice(1)
		.map((raw) => {
			const text = raw
				.split("\n")
				.filter((line) => !/^\s*#/.test(line))
				.join("\n")
				.trimEnd();
			return { name: text.match(/^ {6}- name: (.*)$/m)?.[1] ?? "", text };
		});
}

export function jobStep(job, name) {
	const step = jobSteps(job).find((candidate) => candidate.name === name);
	if (!step) throw new Error(`no step ${name}`);
	return step.text;
}

/** The expression inside a job-level `<key>: ${{ ... }}` line. */
export function jobExpression(job, key) {
	const match = job.match(new RegExp(`\\n    ${key}: \\$\\{\\{ (.*) \\}\\}\\n`));
	if (!match) throw new Error(`no ${key} expression`);
	return match[1];
}

const TOKEN = /\s*(\(|\)|&&|\|\||==|!=|!|'(?:[^']|'')*'|-?\d+(?:\.\d+)?|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*)/y;

function tokenize(source) {
	const tokens = [];
	TOKEN.lastIndex = 0;
	while (TOKEN.lastIndex < source.length) {
		if (/^\s*$/.test(source.slice(TOKEN.lastIndex))) break;
		const start = TOKEN.lastIndex;
		const match = TOKEN.exec(source);
		if (!match) throw new Error(`cannot read the expression at ${source.slice(start)}`);
		tokens.push(match[1]);
	}
	return tokens;
}

const truthy = (value) => !(value === false || value === null || value === 0 || value === "" || Number.isNaN(value));
const toNumber = (value) =>
	value === null ? 0 : typeof value === "boolean" ? Number(value) : typeof value === "string" ? (value.trim() === "" ? 0 : Number(value)) : value;

/** GitHub's loose `==`: strings compare case-insensitively, mixed types compare as numbers. */
function looseEqual(left, right) {
	if (typeof left === "string" && typeof right === "string") return left.toLowerCase() === right.toLowerCase();
	if (typeof left === typeof right) return left === right;
	return toNumber(left) === toNumber(right);
}

/**
 * Evaluate a GitHub Actions expression over `context` (`{inputs, needs, ...}`); a missing property reads as null.
 * Supports what job conditions use: `&&`, `||`, `!`, `==`, `!=`, parentheses, literals, `always()`.
 */
export function evaluateExpression(source, context) {
	const tokens = tokenize(source);
	let index = 0;
	const peek = () => tokens[index];
	const take = () => tokens[index++];
	const primary = () => {
		const token = take();
		if (token === "(") {
			const value = or();
			if (take() !== ")") throw new Error(`unbalanced parentheses in ${source}`);
			return value;
		}
		if (token === "always()") return true;
		if (token.endsWith("()")) throw new Error(`unsupported function ${token}`);
		if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
		if (/^-?\d/.test(token)) return Number(token);
		if (token === "true" || token === "false") return token === "true";
		if (token === "null") return null;
		return token.split(".").reduce((value, key) => (value && typeof value === "object" && key in value ? value[key] : null), context);
	};
	const comparison = () => {
		const left = primary();
		if (peek() === "==" || peek() === "!=") {
			const negate = take() === "!=";
			return looseEqual(left, primary()) !== negate;
		}
		return left;
	};
	const unary = () => (peek() === "!" ? (take(), !truthy(unary())) : comparison());
	const and = () => {
		let value = unary();
		while (peek() === "&&") {
			take();
			const right = unary();
			value = truthy(value) ? right : value;
		}
		return value;
	};
	const or = () => {
		let value = and();
		while (peek() === "||") {
			take();
			const right = and();
			value = truthy(value) ? value : right;
		}
		return value;
	};
	const value = or();
	if (index !== tokens.length) throw new Error(`unexpected ${tokens[index]} in ${source}`);
	return value;
}

export const isTruthy = truthy;
