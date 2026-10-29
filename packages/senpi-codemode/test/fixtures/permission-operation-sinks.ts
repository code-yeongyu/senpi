import type { OperationRow } from "./permission-operation-fs.ts";

// Every way a cell can hold a file-backed handle for the row's path. The decision is keyed by the
// handle's intrinsic path, so a copy that lost object identity is still the same file (#4391).
const origins = [
	["native", "Bun.file(p)"],
	["fetch-minted", "await (await Bun.fetch('file://'+p)).blob()"],
	["cloned fetch-minted", "structuredClone(await (await Bun.fetch('file://'+p)).blob())"],
	["name-overridden", "Object.defineProperty(Bun.file(p),'name',{value:q,configurable:true})"],
] as const;

const writeSinks = [
	["Bun.write(destination)", "const result=await Bun.write(handle,'changed');", "number"],
	["BunFile.write", "const result=await handle.write('changed');", "number"],
	["BunFile.writer", "const w=handle.writer();w.write('changed');const result=await w.end();", "number"],
	["Bun.spawn(stdout)", "const result=await Bun.spawn({cmd:['/bin/echo','spawned'],stdout:handle}).exited;", "number"],
	["Bun.spawn(stderr)", "const result=await Bun.spawn({cmd:['/bin/echo','spawned'],stderr:handle}).exited;", "number"],
	[
		"Bun.spawnSync(stdout)",
		"const result=Bun.spawnSync({cmd:['/bin/echo','spawned'],stdout:handle}).exitCode;",
		"number",
	],
	// Bun gives an explicit stdio slot priority over the matching named option, so a row that sets both
	// proves the slot itself is decided instead of the named key standing in for it.
	[
		"Bun.spawn(stdio[1] over stdout)",
		"const result=await Bun.spawn({cmd:['/bin/echo','spawned'],stdout:'ignore',stdio:['ignore',handle,'ignore']}).exited;",
		"number",
	],
	[
		"Bun.spawn(stdio[2] over stderr)",
		"const result=await Bun.spawn({cmd:['/bin/sh','-c','echo spawned >&2'],stderr:'ignore',stdio:['ignore','ignore',handle]}).exited;",
		"number",
	],
	[
		"Bun.spawnSync(stdio[1] over stdout)",
		"const result=Bun.spawnSync({cmd:['/bin/echo','spawned'],stdout:'ignore',stdio:['ignore',handle,'ignore']}).exitCode;",
		"number",
	],
] as const;

// A slot at index 3 or above has no named option and is opened for both directions, so it is decided
// for read and for write. The read decision is asked first, the order an O_RDWR open already uses, so
// the refusal arrives there even though the child only writes to the descriptor.
const extraSlotSinks = [
	[
		"Bun.spawn(stdio[3] write)",
		"const result=await Bun.spawn({cmd:['/bin/sh','-c','echo spawned >&3'],stdio:['ignore','ignore','ignore',handle]}).exited;",
		"number",
	],
] as const;

const readSinks = [
	[
		"Bun.spawn(stdin)",
		"const p2=Bun.spawn({cmd:['/bin/cat'],stdin:handle,stdout:'pipe'});const result=await new Response(p2.stdout).text();",
	],
	["Bun.write(parts array)", "await Bun.write(q,[handle]);const result=fs.readFileSync(q,'utf8');"],
	["BunFile.write(parts array)", "await Bun.file(q).write([handle]);const result=fs.readFileSync(q,'utf8');"],
	[
		"Bun.serve(routes)",
		"let result;const s=Bun.serve({port:0,routes:{'/f':handle}});try{result=await (await fetch(new URL('/f',s.url))).text();}finally{s.stop(true);}",
	],
	[
		"Bun.serve(static)",
		"let result;const s=Bun.serve({port:0,static:{'/f':handle},fetch(){return new Response('miss');}});try{result=await (await fetch(new URL('/f',s.url))).text();}finally{s.stop(true);}",
	],
	// The read direction of the same precedence gap: the slot wins, so the named key cannot be the
	// only thing decided.
	[
		"Bun.spawn(stdio[0] over stdin)",
		"const p2=Bun.spawn({cmd:['/bin/cat'],stdin:'ignore',stdio:[handle,'pipe','ignore']});const result=await new Response(p2.stdout).text();",
	],
	// Bun opens a slot at index 3 or above for reading too, so the child can read the file back out.
	[
		"Bun.spawn(stdio[3] read)",
		"const p2=Bun.spawn({cmd:['/bin/sh','-c','cat <&3'],stdio:['ignore','pipe','ignore',handle]});const result=await new Response(p2.stdout).text();",
	],
	// A route value may be a per-method map; Bun reads the handle out of it exactly like the flat form.
	[
		"Bun.serve(per-method routes)",
		"let result;const s=Bun.serve({port:0,routes:{'/f':{GET:handle}}});try{result=await (await fetch(new URL('/f',s.url))).text();}finally{s.stop(true);}",
	],
] as const;

// A read-denied path yields a stand-in, and its metadata is a read of the same file: these rows fail
// unless the stand-in decides metadata the way it decides content.
const metadataSinks: readonly OperationRow[] = [
	{ api: "BunFile.size", tool: "read", shape: "number", code: "const result=Bun.file(p).size;" },
	{ api: "BunFile.lastModified", tool: "read", shape: "number", code: "const result=Bun.file(p).lastModified;" },
	{ api: "BunFile.exists", tool: "read", shape: "boolean", code: "const result=await Bun.file(p).exists();" },
	{ api: "BunFile.stat", tool: "read", shape: "number", code: "const result=(await Bun.file(p).stat()).size;" },
	{ api: "BunFile.slice().size", tool: "read", shape: "number", code: "const result=Bun.file(p).slice(0,1).size;" },
];

export const sinkOperations: readonly OperationRow[] = [
	...metadataSinks,
	...writeSinks.flatMap(([sink, code, shape]) =>
		origins.map(([origin, mint]): OperationRow => ({
			api: `${sink} via ${origin}`,
			tool: "write",
			shape,
			code: `const handle=${mint};${code}`,
		})),
	),
	...extraSlotSinks.flatMap(([sink, code, shape]) =>
		origins.map(([origin, mint]): OperationRow => ({
			api: `${sink} via ${origin}`,
			tool: "read",
			shape,
			code: `const handle=${mint};${code}`,
		})),
	),
	...readSinks.flatMap(([sink, code]) =>
		origins
			// A fetch-minted handle is the documented read residual; it is proven at the write sinks only.
			.filter(([origin]) => origin !== "fetch-minted")
			.map(([origin, mint]): OperationRow => ({
				api: `${sink} via ${origin}`,
				tool: "read",
				shape: "string",
				code: `const handle=${mint};${code}if(result!=='{}')throw new Error('wrong file content: '+result);`,
			})),
	),
];

// Controls: with the row path read-denied, everything below must still behave exactly as before.
export const sinkControls = [
	{
		api: "allowed path keeps the native handle",
		code: "const a=q+'-native';fs.writeFileSync(a,'{}');const f=Bun.file(a);return JSON.stringify([f instanceof Blob,Object.getPrototypeOf(f)===Object.getPrototypeOf(new Blob([])),typeof f.slice(0,1).text==='function']);",
		expected: "[true,true,true]",
	},
	{
		api: "allowed path keeps native consumers",
		code: "const a=q+'-consumers';fs.writeFileSync(a,'{}');const f=Bun.file(a);const s=Bun.serve({port:0,routes:{'/f':f}});try{return JSON.stringify([await new Response(f).text(),await structuredClone(f).text(),await (await fetch(new URL('/f',s.url))).text(),await new Response(Bun.spawn({cmd:['/bin/cat'],stdin:f,stdout:'pipe'}).stdout).text()]);}finally{s.stop(true);}",
		expected: '["{}","{}","{}","{}"]',
	},
	{
		api: "allowed path keeps postMessage transport",
		code: "const a=q+'-port';fs.writeFileSync(a,'{}');const {port1,port2}=new MessageChannel();try{const received=new Promise(resolve=>{port2.onmessage=event=>resolve(event.data);});port1.postMessage(Bun.file(a));return await (await received).text();}finally{port1.close();port2.close();}",
		expected: "{}",
	},
	{
		api: "read-denied handle still writes through an allowed sink",
		code: "return String(await Bun.write(Bun.file(p),'written'));",
		expected: "7",
	},
	{
		api: "memory File named like a path is never refused",
		code: "return await new File(['{}'],'memory-named').text();",
		expected: "{}",
	},
];
