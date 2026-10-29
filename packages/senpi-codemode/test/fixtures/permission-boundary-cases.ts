export const capabilityCases = [
	["bun:ffi", "await import('bun:ffi')"],
	["node:vm", "require('node:vm')"],
	["node:worker_threads import", "await import('node:worker_threads')"],
	["node:worker_threads builtin", "process.getBuiltinModule('node:worker_threads')"],
	["process.binding", "process.binding('fs')"],
	["process._linkedBinding", "process._linkedBinding('missing_permission_fixture')"],
	["process.dlopen", "process.dlopen({exports:{}},'/missing_permission_fixture.node')"],
	[".node addon", "require(addon)"],
	["Bun.plugin", "Bun.plugin({name:'cell',setup(){}})"],
	["globalThis.Bun.plugin", "globalThis.Bun.plugin({name:'cell-global',setup(){}})"],
	["module.register", "require('node:module').register('file:///missing_permission_fixture.mjs')"],
	["require.cache mutation", "require.cache.fake={exports:{}}"],
	["Module._load mutation", "const m=require('node:module');m._load=m._load"],
	["nonliteral eval", "const body='1+1';eval(body)"],
	["nonliteral Function", "const body='return 1';new Function(body)"],
	["Bun.$.Shell", "new Bun.$.Shell()"],
	["Bun.mmap shared", "Bun.mmap(p,{shared:true})"],
	["unknown integer fd", "require('node:fs').readSync(987654,new Uint8Array(1),0,1,0)"],
	["inherited fd", "require('node:fs').writeSync(1,'')"],
] as const;

export const resourceCases = [
	[
		"fd write-only read",
		"const fd=fs.openSync(p,'w');try {fs.readSync(fd,new Uint8Array(1),0,1,0);} finally {fs.closeSync(fd)}",
	],
	["fd read-only write", "const fd=fs.openSync(p,'r');try {fs.writeSync(fd,'bad');} finally {fs.closeSync(fd)}"],
	[
		"FileHandle write-only read",
		"const h=await fs.promises.open(p,'w');try {await h.readFile();} finally {await h.close()}",
	],
	[
		"FileHandle read-only write",
		"const h=await fs.promises.open(p,'r');try {await h.writeFile('bad');} finally {await h.close()}",
	],
	[
		"BunFile fd write-only read",
		"const fd=fs.openSync(p,'w');try {await Bun.file(fd).text();} finally {fs.closeSync(fd)}",
	],
	[
		"node sqlite attach",
		`const db=new (require('node:sqlite').DatabaseSync)(':memory:');try {db.exec(\`ATTACH '\${q}' AS other\`);} finally {db.close()}`,
	],
	[
		"node sqlite authorizer compose",
		`const db=new (require('node:sqlite').DatabaseSync)(':memory:');db.setAuthorizer(()=>0);try {db.exec(\`ATTACH '\${q}' AS other\`);} finally {db.close()}`,
	],
	[
		"node sqlite extension enable",
		"const db=new (require('node:sqlite').DatabaseSync)(':memory:',{allowExtension:true});try {db.enableLoadExtension(true);} finally {db.close()}",
	],
	[
		"node sqlite extension load",
		"const db=new (require('node:sqlite').DatabaseSync)(':memory:',{allowExtension:true});try {db.loadExtension(q);} finally {db.close()}",
	],
	[
		"bun sqlite attach",
		`const db=new (require('bun:sqlite').Database)(':memory:');try {db.exec(\`/*prefix*/ ATTACH '\${q}' AS other\`);} finally {db.close()}`,
	],
	[
		"bun sqlite vacuum into",
		`const db=new (require('bun:sqlite').Database)(':memory:');try {db.exec(\`VACUUM INTO '\${q}'\`);} finally {db.close()}`,
	],
	[
		"bun sqlite prepared attach",
		`const db=new (require('bun:sqlite').Database)(':memory:');try {db.prepare(\`ATTACH '\${q}' AS other\`).run();} finally {db.close()}`,
	],
	[
		"bun sqlite extension load",
		"const db=new (require('bun:sqlite').Database)(':memory:');try {db.loadExtension(q);} finally {db.close()}",
	],
] as const;
