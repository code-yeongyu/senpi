export interface OperationRow {
	readonly api: string;
	readonly tool: "read" | "write" | "ls" | "bash";
	readonly code: string;
	readonly shape: string;
	readonly seed?: "directory" | "missing" | "link" | "executable" | "module" | "database";
}

// Each expansion is a distinct API/call-form row, not a sample of a family.
const operations = [
	["writeFile", 'p,"changed"', "write", "missing", "undefined"],
	["appendFile", 'p,"changed"', "write", "missing", "undefined"],
	["truncate", "p,0", "write", undefined, "undefined"],
	["mkdir", "p", "write", "missing", "undefined"],
	["mkdtemp", "p", "write", "missing", "string"],
	["rm", "p", "write", undefined, "undefined"],
	["rmdir", "p", "write", "directory", "undefined"],
	["unlink", "p", "write", undefined, "undefined"],
	["symlink", "q,p", "write", "missing", "undefined"],
	["chmod", "p,0o600", "write", undefined, "undefined"],
	["chown", "p,process.getuid(),process.getgid()", "write", undefined, "undefined"],
	["lchown", "p,process.getuid(),process.getgid()", "write", "link", "undefined"],
	...(process.platform === "darwin" ? [["lchmod", "p,0o600", "write", "link", "undefined"] as const] : []),
	["utimes", "p,1,1", "write", undefined, "undefined"],
	["lutimes", "p,1,1", "write", "link", "undefined"],
	["rename", "p,q", "write", undefined, "undefined"],
	["link", "p,q+'-linked'", "write", undefined, "undefined"],
	["copyFile", "q,p", "write", "missing", "undefined"],
	["cp", "q,p", "write", "missing", "undefined"],
	["readFile", 'p,"utf8"', "read", undefined, "string"],
	["readlink", "p", "read", "link", "string"],
	["realpath", "p", "read", undefined, "string"],
	["readdir", "p", "ls", "directory", "array"],
] as const;

export const fsOperations: readonly OperationRow[] = [
	// Bun exposes only the promise stub outside macOS; preserve its native error.
	...(process.platform !== "darwin"
		? [
				{
					api: "fs.promises.lchmod unsupported",
					tool: "write" as const,
					seed: "link" as const,
					shape: "string",
					code: "let result;try {await fs.promises.lchmod(p,0o600);} catch(error) {if(error.code!=='ERR_METHOD_NOT_IMPLEMENTED')throw error;result=error.code;}if(result!=='ERR_METHOD_NOT_IMPLEMENTED')throw new Error('expected native unsupported result');",
				},
			]
		: []),
	...operations.flatMap(([name, args, tool, seed, shape]) =>
		[
			{ api: `fs.${name}Sync`, code: `const result=fs.${name}Sync(${args});` },
			{
				api: `fs.${name}`,
				code: `const result=await new Promise((resolve,reject)=>fs.${name}(${args},(error,value)=>error?reject(error):resolve(value)));`,
			},
			{ api: `fs.promises.${name}`, code: `const result=await fs.promises.${name}(${args});` },
		].map((row) => ({ ...row, tool, shape, ...(seed ? { seed } : {}) })),
	),
	...["copyFile", "cp"].flatMap((name) =>
		["Sync", "Promise", "Callback"].map((form): OperationRow => ({
			api: `fs.${name}(${form}, source)`,
			tool: "read",
			shape: "undefined",
			code:
				form === "Sync"
					? `const result=fs.${name}Sync(p,q);`
					: form === "Promise"
						? `const result=await fs.promises.${name}(p,q);`
						: `const result=await new Promise((resolve,reject)=>fs.${name}(p,q,e=>e?reject(e):resolve()));`,
		})),
	),
	{
		api: "fs.renameSync(destination)",
		tool: "write",
		seed: "missing",
		shape: "undefined",
		code: "const result=fs.renameSync(q,p);",
	},
	{
		api: "fs.linkSync(destination)",
		tool: "write",
		seed: "missing",
		shape: "undefined",
		code: "const result=fs.linkSync(q,p);",
	},
	{
		api: "fs.createReadStream",
		tool: "read",
		shape: "string",
		code: "let result=''; for await(const chunk of fs.createReadStream(p)) result+=chunk;",
	},
	{
		api: "fs.createWriteStream",
		tool: "write",
		seed: "missing",
		shape: "boolean",
		code: "const stream=fs.createWriteStream(p); const result=await new Promise((resolve,reject)=>{stream.on('error',reject);stream.on('finish',()=>resolve(true));stream.end('changed');});",
	},
	{ api: "fs.openAsBlob", tool: "read", shape: "string", code: "const result=await (await fs.openAsBlob(p)).text();" },
	...["Sync", "Callback", "Promise"].map((form): OperationRow => ({
		api: `fs.opendir(${form})`,
		tool: "ls",
		seed: "directory",
		shape: "string",
		code:
			form === "Sync"
				? "const dir=fs.opendirSync(p); const result=dir.path;dir.closeSync();"
				: `const dir=${form === "Promise" ? "await fs.promises.opendir(p)" : "await new Promise((resolve,reject)=>fs.opendir(p,(e,d)=>e?reject(e):resolve(d)))"};const result=dir.path;await dir.close();`,
	})),
	...["Sync", "Callback", "Promise"].map((form): OperationRow => ({
		api: `fs.glob(${form})`,
		tool: "ls",
		seed: "directory",
		shape: "array",
		code:
			form === "Sync"
				? "const result=fs.globSync('*',{cwd:p});"
				: form === "Promise"
					? "const result=[];for await(const item of fs.promises.glob('*',{cwd:p})) result.push(item);"
					: "const result=await new Promise((resolve,reject)=>fs.glob('*',{cwd:p},(e,v)=>e?reject(e):resolve(v)));",
	})),
	...["r", "w", "r+", "a", "wx", "ax", "w+", "a+"].flatMap((flags) =>
		["Sync", "Callback", "Promise"].map((form): OperationRow => ({
			api: `fs.open(${form},${flags})`,
			tool: flags.includes("+") || flags === "r" ? "read" : "write",
			...(flags.includes("x") ? { seed: "missing" as const } : {}),
			shape: "number",
			code:
				form === "Sync"
					? `const result=fs.openSync(p,'${flags}');fs.closeSync(result);`
					: form === "Promise"
						? `const h=await fs.promises.open(p,'${flags}');const result=h.fd;await h.close();`
						: `const result=await new Promise((resolve,reject)=>fs.open(p,'${flags}',(e,fd)=>e?reject(e):resolve(fd)));fs.closeSync(result);`,
		})),
	),
	...[
		["omitted flags", ""],
		["undefined flags", "undefined,"],
		["null flags", "null,"],
		["flags and mode", "'r',0o600,"],
	].map(([name, args]): OperationRow => ({
		api: `fs.open(${name})`,
		tool: "read",
		shape: "string",
		code: `const fd=await new Promise((resolve,reject)=>fs.open(p,${args}(e,fd)=>e?reject(e):resolve(fd)));try {const result=fs.readFileSync(fd,'utf8');if(result!=='{}')throw new Error('wrong file');} finally {fs.closeSync(fd)} const result='{}';`,
	})),
	...["", "undefined", "null"].flatMap((flags) =>
		["Sync", "Promise"].map((form): OperationRow => ({
			api: `fs.open(${form},${flags || "omitted"})`,
			tool: "read",
			shape: "number",
			code:
				form === "Sync"
					? `const result=fs.openSync(p${flags ? `,${flags}` : ""});fs.closeSync(result);`
					: `const h=await fs.promises.open(p${flags ? `,${flags}` : ""});const result=h.fd;await h.close();`,
		})),
	),
	{ api: "prelude.read", tool: "read", shape: "string", code: "const result=await read(p);" },
	{
		api: "prelude.write",
		tool: "write",
		seed: "missing",
		shape: "string",
		code: "const result=await write(p,'changed');",
	},
];
