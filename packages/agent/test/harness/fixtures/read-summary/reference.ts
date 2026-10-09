import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { sha256 } from "./scorer.ts";
import { verifyTokenizer } from "./tokenizer-identity.ts";

const nodeSchema = z.object({
	text: z.string(),
	byteStart: z.number(),
	byteEnd: z.number(),
	startLine: z.number(),
	endLine: z.number(),
});
export type SourceNode = z.infer<typeof nodeSchema>;
export const referenceSchema = z.object({
	settings: z.record(z.string(), z.unknown()),
	results: z.array(
		z.object({
			id: z.string(),
			sourceSha256: z.string(),
			text: z.string(),
			result: z.unknown(),
			latencyMs: z.number(),
			nodes: z.array(nodeSchema),
			annotationErrors: z.array(z.string()),
		}),
	),
	tokenizer: z.object({
		name: z.string(),
		version: z.string(),
		encoding: z.string(),
		exact: z.literal(true),
		files: z.record(z.string(), z.string()),
		packageSha256: z.string(),
		lockIntegrity: z.string(),
	}),
});
export type Request = { readonly id: string; readonly file: string; readonly language: string };

// A process boundary intentionally loads the pinned, execution-owned comparator.
// No reference/native/tokenizer module is linked into the senpi runtime or prototype.
export function runReference(root: string, requests: readonly Request[]) {
	const readToolSha256 = sha256(readFileSync(join(root, "packages/coding-agent/src/tools/read.ts")));
	if (readToolSha256 !== "270694388f57680524c3df3f6223e845dc8c4d78e2146748d2013c63ae9ba935")
		throw new Error("reference_pin_drift");
	const scratch = mkdtempSync(join(root, "bakeoff-response-"));
	const response = join(scratch, "response.json");
	const moduleUrl = (relative: string) => JSON.stringify(pathToFileURL(join(root, relative)).href);
	const program = `
import { ReadTool } from ${moduleUrl("packages/coding-agent/src/tools/read.ts")};
import { Settings } from ${moduleUrl("packages/coding-agent/src/config/settings.ts")};
import { astMatch } from ${moduleUrl("packages/natives/native/index.js")};
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
const requests = JSON.parse(readFileSync(0, "utf8"));
const settings = Settings.isolated();
const keys = ["read.summarize.enabled", "read.summarize.prose", "read.summarize.minBodyLines", "read.summarize.minCommentLines", "read.summarize.minTotalLines", "read.summarize.unfoldUntil", "read.summarize.unfoldLimit", "read.defaultLimit", "readLineNumbers", "edit.mode"];
const results = [];
for (const request of requests) {
 const source = readFileSync(request.file, "utf8");
 const nodes = request.language === "rust" ? await astMatch({source,lang:"rust",patterns:["$A"],limit:100000}) : {matches:[]};
 if (nodes.limitReached) throw new Error("Reference source annotation truncated: " + request.id);
 const tool = new ReadTool({cwd:${JSON.stringify(join(root, "..", "input", "sources"))},hasUI:false,settings,getSessionSpawns:()=>"*"});
 const start = performance.now();
 const result = await tool.execute(request.id, {path:request.file});
 const latencyMs = performance.now() - start;
 if (result.isError) throw new Error("ReadTool returned isError");
 const text = result.content.filter(c=>c.type==="text").map(c=>c.text).join("\\n");
 if (!text) throw new Error("ReadTool returned no text");
 results.push({id:request.id,sourceSha256:createHash("sha256").update(source).digest("hex"),text,result,latencyMs,nodes:nodes.parseErrors?.length ? [] : nodes.matches,annotationErrors:nodes.parseErrors ?? []});
}
const tokenizerRoot = ${JSON.stringify(join(root, "node_modules/gpt-tokenizer"))};
const files = {};
for (const name of ["package.json","esm/encoding/o200k_base.js","esm/bpeRanks/o200k_base.js"]) {
 files[name] = createHash("sha256").update(readFileSync(tokenizerRoot+"/"+name)).digest("hex");
}
const pkg=JSON.parse(readFileSync(tokenizerRoot+"/package.json","utf8"));
if(pkg.version!=="4.0.0") throw new Error("Tokenizer version drift");
const packageHash = createHash("sha256");
for(const name of readdirSync(tokenizerRoot,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>e.parentPath.slice(tokenizerRoot.length+1)+"/"+e.name).sort()) {
 packageHash.update(name); packageHash.update(readFileSync(tokenizerRoot+"/"+name));
}
writeFileSync(${JSON.stringify(response)},JSON.stringify({settings:Object.fromEntries(keys.map(k=>[k,settings.get(k)])),results,tokenizer:{name:"gpt-tokenizer",version:pkg.version,encoding:"o200k_base",exact:true,files,packageSha256:packageHash.digest("hex"),lockIntegrity:"sha512-YAWIyzvuVUHEfW7tFfFAxH8qQb+Q3RU9nYOTy7skMNX5qzU6Q8jxTHZLyO56ug1vYvCR7wndzpd3jwD86/mhjQ=="}}));
`;
	try {
		// Large console output can be cut short by reference process shutdown.
		// Synchronous file transport completes before exit and is schema-checked.
		execFileSync(process.execPath, ["--eval", program], {
			cwd: root,
			input: JSON.stringify(requests),
			encoding: "utf8",
			timeout: 120000,
		});
		return {
			...referenceSchema.parse(JSON.parse(readFileSync(response, "utf8"))),
			command: [process.execPath, "--eval", program],
			readToolSha256,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function tokenize(
	root: string,
	texts: readonly string[],
	identity: z.infer<typeof referenceSchema>["tokenizer"],
): number[] {
	verifyTokenizer(root, identity);
	const program = `import { encode } from ${JSON.stringify(pathToFileURL(join(root, "node_modules/gpt-tokenizer/esm/encoding/o200k_base.js")).href)};
import { readFileSync } from "node:fs";
console.log(JSON.stringify(JSON.parse(readFileSync(0,"utf8")).map(text=>encode(text).length)));`;
	const stdout = execFileSync(process.execPath, ["--eval", program], {
		cwd: root,
		input: JSON.stringify(texts),
		encoding: "utf8",
		timeout: 120000,
		maxBuffer: 1024 * 1024,
	});
	return z.array(z.number().int().nonnegative()).parse(JSON.parse(stdout));
}
