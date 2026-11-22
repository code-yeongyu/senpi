const REDIRECT_TARGET_END = /[\s;|&)<>]/;

/**
 * Rewrites output redirects whose target is the cmd.exe device name `nul` (`>nul`, `2>nul`, `&>nul`,
 * `>>NUL`, `>|nul`) to `/dev/null`. Git Bash runs the bash tool on Windows, and it creates a literal
 * `nul` file for them, which git cannot index (senpi#3765). Only an unquoted redirect target that is
 * exactly `nul` (any case) changes; quoted text, comments, words such as `nullable` or `nul.txt`, and
 * input redirects stay as written. A command with a here-document is returned unchanged.
 */
export function mapWindowsNulRedirects(command: string): string {
	if (command.includes("<<")) return command;
	let out = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote !== undefined) {
			out += ch;
			if (ch === "\\" && quote === '"' && i + 1 < command.length) out += command[++i];
			else if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			out += ch + command[++i];
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
			const end = command.indexOf("\n", i);
			out += end === -1 ? command.slice(i) : command.slice(i, end);
			i = end === -1 ? command.length : end - 1;
			continue;
		}
		if (ch !== ">") {
			out += ch;
			continue;
		}
		let j = i + 1;
		if (command[j] === ">" || command[j] === "|") j++;
		if (command[j] === "&") {
			out += command.slice(i, j);
			i = j - 1;
			continue;
		}
		let k = j;
		while (command[k] === " " || command[k] === "\t") k++;
		const word = command.slice(k, k + 3);
		const after = command[k + 3];
		if (word.toLowerCase() === "nul" && (after === undefined || REDIRECT_TARGET_END.test(after))) {
			out += `${command.slice(i, k)}/dev/null`;
			i = k + 2;
			continue;
		}
		out += command.slice(i, j);
		i = j - 1;
	}
	return out;
}
