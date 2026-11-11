import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

// omo#12965: the built package carries the redaction module more than once (the SDK graph, the bundle's shared chunk
// and the self-contained session-worker entry). The session worker and an in-process child on the SDK share one
// worker realm, so every emitted copy is loaded next to the SDK copy inside one Worker and must redact the values the
// other one remembered. Runs against the built package (`bun run build`), like the other dist-dependent suites.

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const BUNDLE = join(DIST, "bundle");
const SDK_COPY = join(DIST, "core", "config-reference-redaction.js");
const SLOT_KEY = "@code-yeongyu/senpi/config-reference-redaction/v1";
const DEFINES_REMEMBER = /function (rememberResolvedReferenceValue\d*)\(/;
const DEFINES_REDACT = /function (redactResolvedReferenceValues\d*)\(/;
const LAZY_INIT =
	/(init_config_reference_redaction\d*)=__esm\(\{"packages\/coding-agent\/dist\/core\/config-reference-redaction\.js"\(\)\{/;
const ESM_SHIM =
	"var __esm=(fn,res)=>function(){return fn&&(res=(0,fn[Object.getOwnPropertyNames(fn)[0]])(fn=0)),res};";

interface EmittedCopy {
	name: string;
	text: string;
}

interface LoadableCopy {
	name: string;
	url: string;
	remember: string;
	redact: string;
}

function emittedCopies(): EmittedCopy[] {
	if (!existsSync(SDK_COPY) || !existsSync(BUNDLE)) {
		throw new Error(`the built package is missing under ${DIST}: run \`bun run build\` first`);
	}
	return readdirSync(BUNDLE, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".js"))
		.map((name) => ({ name: name.replaceAll("\\", "/"), text: readFileSync(join(BUNDLE, name), "utf8") }))
		.filter((copy) => DEFINES_REMEMBER.test(copy.text));
}

function matchingBrace(text: string, from: number, step: 1 | -1): number {
	let depth = 0;
	for (let index = from; index >= 0 && index < text.length; index += step) {
		if (text[index] === "{") depth += step;
		else if (text[index] === "}") depth -= step;
		if (depth === 0) return index;
	}
	throw new Error(`unbalanced braces from offset ${from}`);
}

/** The lazily initialised module region of a self-contained entry: its hoisted functions plus its `var ... __esm` line. */
function lazyModuleUrl(copy: EmittedCopy, init: RegExpExecArray): LoadableCopy {
	const { text } = copy;
	const bodyClose = matchingBrace(text, init.index + init[0].length - 1, 1);
	const end = bodyClose + 1 + "})".length;
	const head = /var [\w$]+(?:,[\w$]+)*,$/.exec(text.slice(Math.max(0, init.index - 4000), init.index));
	if (head === null) throw new Error(`no var statement before ${init[1]} in ${copy.name}`);
	let start = init.index - head[0].length;
	while (text[start - 1] === "}") {
		const open = matchingBrace(text, start - 1, -1);
		const signature = /function [\w$]+\([^()]*\)$/.exec(text.slice(Math.max(0, open - 400), open));
		if (signature === null) break;
		start = open - signature[0].length;
	}
	const region = text.slice(start, end);
	const remember = DEFINES_REMEMBER.exec(region)?.[1];
	const redact = DEFINES_REDACT.exec(region)?.[1];
	if (remember === undefined || redact === undefined) throw new Error(`incomplete module region in ${copy.name}`);
	const source = `${ESM_SHIM}\n${region}\n${init[1]}();\nexport { ${remember} as remember, ${redact} as redact };\n`;
	return {
		name: copy.name,
		url: `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
		remember: "remember",
		redact: "redact",
	};
}

/** A shared chunk is an ES module of its own: import it and map its minified export names. */
function chunkModule(copy: EmittedCopy): LoadableCopy {
	const exported = new Map<string, string>();
	for (const clause of copy.text.matchAll(/export\s*\{([^}]*)\}/g)) {
		for (const specifier of (clause[1] ?? "").split(",")) {
			const [local, alias] = specifier.trim().split(/\s+as\s+/);
			if (local) exported.set(local, alias ?? local);
		}
	}
	const remember = exported.get(DEFINES_REMEMBER.exec(copy.text)?.[1] ?? "");
	const redact = exported.get(DEFINES_REDACT.exec(copy.text)?.[1] ?? "");
	if (remember === undefined || redact === undefined) throw new Error(`${copy.name} does not export the module`);
	return { name: copy.name, url: pathToFileURL(join(BUNDLE, copy.name)).href, remember, redact };
}

function loadable(copy: EmittedCopy): LoadableCopy {
	const init = LAZY_INIT.exec(copy.text);
	return init === null ? chunkModule(copy) : lazyModuleUrl(copy, init);
}

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
	const sdk = await import(workerData.sdk);
	const results = [];
	for (const copy of workerData.copies) {
		const mod = await import(copy.url);
		const toCopy = "sdk-to-copy-" + results.length + "-12965-mark";
		const fromCopy = "copy-to-sdk-" + results.length + "-12965-mark";
		sdk.rememberResolvedReferenceValue(toCopy);
		mod[copy.remember](fromCopy);
		results.push({
			name: copy.name,
			toCopy: mod[copy.redact]("x " + toCopy + " y"),
			fromCopy: sdk.redactResolvedReferenceValues("x " + fromCopy + " y"),
		});
	}
	parentPort.postMessage({ results });
})().catch((error) => parentPort.postMessage({ error: String((error && error.stack) || error) }));
`;

function runInOneWorker(copies: LoadableCopy[]): Promise<{ name: string; toCopy: string; fromCopy: string }[]> {
	const worker = new Worker(WORKER, { eval: true, workerData: { sdk: pathToFileURL(SDK_COPY).href, copies } });
	return new Promise((resolve, reject) => {
		worker.once("error", reject);
		worker.once(
			"message",
			(message: { results?: { name: string; toCopy: string; fromCopy: string }[]; error?: string }) => {
				void worker.terminate();
				if (message.results === undefined) reject(new Error(message.error ?? "the worker sent no results"));
				else resolve(message.results);
			},
		);
	});
}

describe("redaction module copies in the built package (omo#12965)", () => {
	const copies = emittedCopies();

	it("emits the session-worker copy and a shared chunk copy, each carrying the registry slot key", () => {
		expect(copies.map((copy) => copy.name)).toContain("chunks/session-worker.js");
		expect(copies.length).toBeGreaterThanOrEqual(2);
		for (const copy of copies) expect(copy.text, copy.name).toContain(SLOT_KEY);
	});

	it("redacts across the SDK copy and every emitted copy inside one Worker realm", async () => {
		const results = await runInOneWorker(copies.map(loadable));

		expect(results).toEqual(
			copies.map((copy) => ({ name: copy.name, toCopy: "x <redacted> y", fromCopy: "x <redacted> y" })),
		);
	});
});
