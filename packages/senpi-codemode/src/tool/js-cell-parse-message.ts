import { parse } from "@babel/parser";

/** Only consulted after the kernel fails to compile. Locate the error in submitted, not rewritten, code. */
export function jsCellParseMessage(code: string, message: string): string {
	try {
		parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
	} catch (error) {
		if (!(error instanceof SyntaxError) || !("loc" in error)) return message;
		const loc = error.loc;
		if (
			!loc ||
			typeof loc !== "object" ||
			!("line" in loc) ||
			typeof loc.line !== "number" ||
			!("column" in loc) ||
			typeof loc.column !== "number"
		)
			return message;
		const line = code.split(/\r\n|[\r\n\u2028\u2029]/u)[loc.line - 1] ?? "";
		const start = Math.max(0, loc.column - 60);
		const excerpt = line.slice(start, loc.column + 60);
		const caret = excerpt.slice(0, loc.column - start).replace(/[^\t]/gu, " ");
		const hint =
			/<<-?[ \t]*(['"])[A-Za-z_]\w*\1[ \t]*(?:\r?\n|$)/u.test(code) && code.includes("`")
				? "\nFor a shell heredoc in a JS template literal, escape literal backticks and ${ with a backslash, or use ordinary quoted JS strings."
				: "";
		return `${message}\nJS cell line ${loc.line}, column ${loc.column + 1}:\n${excerpt}\n${caret}^${hint}`;
	}
	return message;
}
