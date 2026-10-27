import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MessagePort } from "node:worker_threads";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const scenario = process.argv[2];
if (scenario === "transfer") {
	// A host forward that cannot be cloned must reach the cell as messageerror, never escape the host listener.
	const postMessage = MessagePort.prototype.postMessage;
	MessagePort.prototype.postMessage = function (this: MessagePort, value: unknown, ...rest: unknown[]) {
		if (value !== null && typeof value === "object" && "value" in value && value.value === "unforwardable") {
			throw new DOMException("forced clone failure", "DataCloneError");
		}
		return Reflect.apply(postMessage, this, [value, ...rest]);
	};
}
const root = await mkdtemp(join(tmpdir(), "worker-transparency-"));
const failures: string[] = [];
let rows = 0;
try {
	for (const mode of ["worker", "inline"]) {
		for (const policy of ["absent", "inactive", "active"]) {
			const script = join(root, `${mode}-${policy}.mjs`);
			const marker = join(root, `${mode}-${policy}-marker`);
			const kernel = new JavaScriptKernel({
				sessionId: crypto.randomUUID(),
				cwd: root,
				parallelPoolWidth: 2,
				...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "missing.js")) } : {}),
				...(policy === "absent"
					? {}
					: {
							permissions: {
								state: () => ({ epoch: 1, active: policy === "active", rules: [] }),
								decide: () => ({ action: "pass" as const }),
							},
						}),
			});
			const run = async (code: string) => {
				const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 6_000 });
				assert.equal(result.ok, true, `${JSON.stringify(result)}\n${code}`);
				return result.valueRepr;
			};
			try {
				if (scenario === "lifetime") {
					await writeFile(
						script,
						`
						import {writeFileSync} from "node:fs";
						onmessage=()=>{try { writeFileSync(${JSON.stringify(marker)}, "ok"); postMessage("wrote"); }
							catch(error) { postMessage(error.code); }};
						postMessage("ready");
					`,
					);
					await run(`var child = new Worker(${JSON.stringify(pathToFileURL(script).href)});
						await new Promise((resolve,reject)=>{child.onmessage=resolve;child.onerror=reject});`);
					assert.equal(
						await run(`var reply = new Promise((resolve,reject)=>{child.onmessage=e=>resolve(e.data);child.onerror=reject});
						child.postMessage(null); return await reply;`),
						JSON.stringify(policy === "active" ? "cell_permission_denied" : "wrote"),
					);
					assert.equal(existsSync(marker), policy !== "active");
					// An inactive continuation may also create a Worker after its originating cell settles.
					if (policy !== "active") {
						await run(`var gate = Promise.withResolvers(); var spawned = gate.promise.then(async () => {
							var late = new Worker(${JSON.stringify(pathToFileURL(script).href)});
							await new Promise((resolve,reject)=>{late.onmessage=resolve;late.onerror=reject});
							late.terminate(); return "ready";
						}); return null;`);
						assert.equal(await run("gate.resolve(); return await spawned;"), '"ready"');
					}
				} else if (scenario === "frames") {
					await writeFile(
						script,
						`
						import {parentPort} from "node:worker_threads";
						const values=[null,undefined,false,0,"value",1n,[],{}, {type:"cell-worker-message",value:"user"},
							{key:"user",value:"inner",transfer:[]}];
						onmessage=()=>{for(const value of values) parentPort.postMessage(value); postMessage("done");};
						postMessage("ready");
					`,
					);
					assert.equal(
						await run(`var child = new Worker(${JSON.stringify(pathToFileURL(script).href)});
						await new Promise((resolve,reject)=>{child.onmessage=resolve;child.onerror=reject});
						var frames=[]; var received=new Promise(resolve=>child.onmessage=e=>{
							if(e.data==="done") resolve(); else frames.push(e.data);
						}); child.postMessage(null); await received; child.terminate();
						var valid = frames.length===10 && frames[0]===null && frames[1]===undefined &&
							frames[2]===false && frames[3]===0 && frames[4]==="value" && frames[5]===1n &&
							Array.isArray(frames[6]) && Object.keys(frames[7]).length===0 &&
							frames[8].type==="cell-worker-message" && frames[8].value==="user" &&
							frames[9].key==="user" && frames[9].value==="inner" && Array.isArray(frames[9].transfer);
						if(!valid) throw new Error(JSON.stringify(frames, (_,v)=>typeof v==="bigint" ? String(v)+"n" : v));
						return valid;`),
						"true",
					);
				} else if (scenario === "transfer") {
					await writeFile(
						script,
						`
						import {MessageChannel, parentPort} from "node:worker_threads";
						const open=()=>{const {port1,port2}=new MessageChannel(); port1.on("message",m=>port1.postMessage("pong:"+m)); return port2;};
						onmessage=()=>{
							const bare=open(); parentPort.postMessage(bare,[bare]);
							const nested=open(); parentPort.postMessage({p:nested},[nested]);
							const keyed=open(); postMessage({p:keyed},[keyed]);
							parentPort.postMessage("unforwardable");
							postMessage("done");
						};
						postMessage("ready");
					`,
					);
					assert.equal(
						await run(`var child = new Worker(${JSON.stringify(pathToFileURL(script).href)});
						await new Promise((resolve,reject)=>{child.onmessage=resolve;child.onerror=reject});
						var frames=[]; var errors=[]; child.onmessageerror=e=>errors.push(e.data?.message);
						var received=new Promise(resolve=>child.onmessage=e=>{if(e.data==="done") resolve(); else frames.push(e.data);});
						child.postMessage(null); await received;
						var ports=[frames[0], frames[1]?.p, frames[2]?.p];
						var replies=await Promise.all(ports.map(port=>new Promise((resolve,reject)=>{
							if(typeof port?.postMessage!=="function") return reject(new Error("missing port: "+String(port)));
							port.on("message",reply=>{port.close(); resolve(reply);}); port.postMessage("ping");
						})));
						child.terminate();
						return {frames:frames.length, replies, errors};`),
						JSON.stringify({
							frames: 3,
							replies: ["pong:ping", "pong:ping", "pong:ping"],
							errors: ["Worker message could not be forwarded (DataCloneError): forced clone failure"],
						}),
					);
				} else if (scenario === "worker-data") {
					await writeFile(
						script,
						`
						import {workerData} from "node:worker_threads";
						postMessage({data:workerData, same:process.getBuiltinModule("node:worker_threads").workerData===workerData});
					`,
					);
					assert.equal(
						await run(`var values=[undefined,null,false,4,"hello",[1],{x:1,permission:"user",script:"user"}];
						for(const value of values) {
							var child=new Worker(${JSON.stringify(pathToFileURL(script).href)}, {workerData:value});
							var reply=await new Promise((resolve,reject)=>{child.onmessage=e=>resolve(e.data);child.onerror=reject});
							child.terminate();
							if(!reply.same || JSON.stringify(reply.data)!==JSON.stringify(value)) return false;
						} return true;`),
						"true",
					);
				} else if (scenario === "error") {
					await writeFile(script, `throw new TypeError("worker failure");`);
					assert.equal(
						await run(`var child=new Worker(${JSON.stringify(pathToFileURL(script).href)});
						var event=await new Promise(resolve=>child.onerror=resolve);
						var valid=event.error instanceof TypeError && event.error.message==="worker failure" &&
							event.filename.endsWith(${JSON.stringify(`${mode}-${policy}.mjs`)}) && event.lineno===1 && event.colno>0;
						if(!valid) throw new Error(JSON.stringify({error:String(event.error),name:event.error?.name,filename:event.filename,lineno:event.lineno,colno:event.colno}));
						return valid;`),
						"true",
					);
				} else if (scenario === "close") {
					await writeFile(script, `onmessage=()=>process.exit(0); postMessage("ready");`);
					assert.equal(
						await run(`var child=new Worker(${JSON.stringify(pathToFileURL(script).href)});
						await new Promise((resolve,reject)=>{child.onmessage=resolve;child.onerror=reject});
						var property=0; child.onclose=()=>property++;
						var closed=new Promise(resolve=>child.addEventListener("close",resolve,{once:true}));
						child.postMessage(null); await closed; return property;`),
						"1",
					);
				} else throw new Error(`Unknown scenario: ${scenario}`);
				assert.equal(kernel.mode, mode);
			} catch (error) {
				failures.push(`${mode}/${policy}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				await kernel.close();
				rows++;
			}
		}
	}
	console.log(JSON.stringify({ scenario, rows, failures }));
} finally {
	await rm(root, { recursive: true, force: true });
}
