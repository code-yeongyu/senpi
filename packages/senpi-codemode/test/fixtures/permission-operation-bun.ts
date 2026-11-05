import type { OperationRow } from "./permission-operation-fs.ts";

export const bunOperations: readonly OperationRow[] = [
	...[
		["Bun.write source", "await Bun.write(q,source);const result=fs.readFileSync(q,'utf8');"],
		["BunFile.write source", "await Bun.file(q).write(source);const result=fs.readFileSync(q,'utf8');"],
		["Response body", "const result=await new Response(source).text();"],
		["Request body", "const result=await new Request('http://localhost/',{method:'POST',body:source}).text();"],
		["Blob parts", "const result=await new Blob([source]).text();"],
		["File parts", "const result=await new File([source],'file').text();"],
		["node:buffer Blob parts", "const result=await new (require('node:buffer').Blob)([source]).text();"],
		["node:buffer File parts", "const result=await new (require('node:buffer').File)([source],'file').text();"],
		[
			"FormData.append",
			"const data=new FormData();data.append('file',source);const result=await data.get('file').text();",
		],
		[
			"FormData.set",
			"const data=new FormData();data.set('file',source,'file');const result=await data.get('file').text();",
		],
		["fetch body", "const result=await (await fetch(endpoint,{method:'POST',body:source})).text();"],
		[
			"fetch Request body",
			"const result=await (await fetch(new Request(endpoint,{method:'POST',body:source}))).text();",
		],
	].flatMap(([api, code]) =>
		[false, true].map((slice): OperationRow => ({
			api: `${api}${slice ? " sliced" : ""}`,
			tool: "read",
			shape: "string",
			code: `const source=Bun.file(p)${slice ? ".slice()" : ""};${code}if(result!=='{}')throw new Error('wrong file content');`,
		})),
	),
	...["string", "URL", "BunFile"].map((kind): OperationRow => ({
		api: `Bun.write(${kind})`,
		tool: "write",
		seed: "missing",
		shape: "number",
		code: `const result=await Bun.write(${kind === "URL" ? "new URL('file://'+p)" : kind === "BunFile" ? "Bun.file(p)" : "p"},'changed');`,
	})),
	{
		api: "BunFile.write",
		tool: "write",
		seed: "missing",
		shape: "number",
		code: "const result=await Bun.file(p).write('changed');",
	},
	{
		api: "BunFile.writer",
		tool: "write",
		seed: "missing",
		shape: "number",
		code: "const w=Bun.file(p).writer();w.write('changed');const result=await w.end();",
	},
	...["delete", "unlink"].map((name): OperationRow => ({
		api: `BunFile.${name}`,
		tool: "write",
		shape: "undefined",
		code: `const result=await Bun.file(p).${name}();`,
	})),
	...["text", "json", "bytes", "arrayBuffer", "stream", "formData", "image"].flatMap((name) =>
		[false, true].map((slice): OperationRow => ({
			api: `BunFile${slice ? ".slice()" : ""}.${name}`,
			tool: "read",
			shape:
				name === "text"
					? "string"
					: name === "bytes"
						? "uint8array"
						: name === "arrayBuffer"
							? "arraybuffer"
							: name === "stream"
								? "string"
								: "object",
			code:
				name === "stream"
					? `const result=await new Response(Bun.file(p)${slice ? ".slice()" : ""}.stream()).text();`
					: name === "image"
						? `const result=Bun.file(p)${slice ? ".slice()" : ""}.image();`
						: `const result=await Bun.file(p${name === "formData" ? ",{type:'application/x-www-form-urlencoded'}" : ""})${slice ? ".slice()" : ""}.${name}();`,
		})),
	),
	{ api: "fetch(file)", tool: "read", shape: "string", code: "const result=await (await fetch('file://'+p)).text();" },
	{
		api: "Bun.Glob.scan",
		tool: "ls",
		seed: "directory",
		shape: "array",
		code: "const result=[];for await(const v of new Bun.Glob('*').scan({cwd:p})) result.push(v);",
	},
	{
		api: "Bun.Glob.scanSync",
		tool: "ls",
		seed: "directory",
		shape: "array",
		code: "const result=[...new Bun.Glob('*').scanSync({cwd:p})];",
	},
	{ api: "Bun.mmap(private)", tool: "read", shape: "uint8array", code: "const result=Bun.mmap(p,{shared:false});" },
	{
		api: "node:sqlite.DatabaseSync",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=new (require('node:sqlite').DatabaseSync)(p);result.close();",
	},
	{
		api: "bun:sqlite.Database",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=new (require('bun:sqlite').Database)(p);result.close();",
	},
	{
		api: "bun:sqlite.Database.open",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=require('bun:sqlite').Database.open(p);result.close();",
	},
	{
		api: "bun:sqlite.default",
		tool: "read",
		seed: "database",
		shape: "object",
		code: "const result=new (require('bun:sqlite').default)(p);result.close();",
	},
];

// Memory-backed values share BunFile's prototype but never request a file read (#4391).
export const blobControls = [
	...["new Blob(['{}'])", "new File(['{}'],'memory')", "await new Response('{}').blob()"].flatMap((source) =>
		[
			["text", "await blob.text()", "{}"],
			["json", "JSON.stringify(await blob.json())", "{}"],
			["bytes", "new TextDecoder().decode(await blob.bytes())", "{}"],
			["arrayBuffer", "new TextDecoder().decode(await blob.arrayBuffer())", "{}"],
			["stream", "await new Response(blob.stream()).text()", "{}"],
			["slice", "await blob.slice().text()", "{}"],
			["Response", "await new Response(blob).text()", "{}"],
			["Request", "await new Request('http://localhost/',{method:'POST',body:blob}).text()", "{}"],
			["Bun.write", "(await Bun.write(q,blob),fs.readFileSync(q,'utf8'))", "{}"],
		].map(([name, expression, expected]) => ({
			api: `${source}/${name}`,
			code: `const blob=${source};return ${expression};`,
			expected,
		})),
	),
	{
		api: "memory formData",
		code: "return (await new Blob(['a=b'],{type:'application/x-www-form-urlencoded'}).formData()).get('a');",
		expected: "b",
	},
	{
		api: "read-denied BunFile write-only destination",
		code: "await Bun.write(Bun.file(p),'written');return 'written';",
		expected: "written",
	},
];
