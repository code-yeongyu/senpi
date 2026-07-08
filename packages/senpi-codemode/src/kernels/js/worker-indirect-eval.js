export function indirectEval(source, filename) {
	const withPragma = filename ? `${source}\n//# sourceURL=${filename}` : source;
	const geval = globalThis.eval;
	return geval(withPragma);
}

export async function awaitMaybePromise(value) {
	if (!value || typeof value !== "object" || typeof value.then !== "function") return value;
	return await value;
}

export function wrapUserCode(code) {
	const persistentCode = code.replace(/(^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gu, "$1globalThis.$2 =");
	if (/\breturn\b/u.test(persistentCode)) return `(async () => {\n${persistentCode}\n})()`;
	return `(async () => {\n${captureLastExpression(persistentCode)}\n})()`;
}

function captureLastExpression(code) {
	const start = findLastTopLevelStatementStart(code);
	const head = code.slice(0, start);
	const tail = code.slice(start).trim();
	if (!tail || isStatementOnly(tail)) return code;
	return `${head}return ${tail.replace(/;+$/u, "")};`;
}

function isStatementOnly(source) {
	return /^(?:const|let|var|if|for|while|switch|try|catch|finally|class|function|import|export|throw|return|do|break|continue|debugger)\b/u.test(
		source,
	);
}

function findLastTopLevelStatementStart(code) {
	let start = 0;
	let round = 0;
	let square = 0;
	let curly = 0;
	let quote = "";
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = 0; index < code.length; index += 1) {
		const char = code[index];
		const next = code[index + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === quote) {
				quote = "";
			}
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") round += 1;
		else if (char === ")") round -= 1;
		else if (char === "[") square += 1;
		else if (char === "]") square -= 1;
		else if (char === "{") curly += 1;
		else if (char === "}") curly -= 1;
		else if ((char === ";" || char === "\n") && round === 0 && square === 0 && curly === 0) start = index + 1;
	}
	return start;
}
