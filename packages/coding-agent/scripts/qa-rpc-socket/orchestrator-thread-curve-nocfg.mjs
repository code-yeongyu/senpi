import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sandbox = mkdtempSync(join("/tmp", "dh-m"));
const agentDir = join(sandbox, "agent"); mkdirSync(agentDir, { recursive: true });
const sessionDir = join(sandbox, "sessions"); mkdirSync(sessionDir, { recursive: true });
const socket = join(sandbox, "h.sock");
const env = { ...process.env, SENPI_CODING_AGENT_DIR: agentDir };
delete env.OMO_RPC_SOCKET_PATH; delete env.SENPI_RPC_HOST_WATCH_FD; delete env.OMO_RPC_SOCKET; delete env.SENPI_RPC_SOCKET; delete env.PI_RPC_SOCKET;
const host = spawn("bun", ["packages/coding-agent/src/cli.ts", "--mode", "rpc", "--multi-session", "--listen", "unix://" + socket, "--no-extensions", "--no-skills", "--no-prompt-templates", "--disable-builtin", "config-reload"], { env, stdio: ["ignore", "pipe", "pipe"] });
let ready = false; host.stderr.on("data", (b) => { if (String(b).includes("listening")) ready = true; });
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
await until(async () => ready);
const stats = async () => {
  const run = (cmd) => new Promise((res) => { const p = spawn("sh", ["-c", cmd]); let o = ""; p.stdout.on("data", (b) => (o += b)); p.on("close", () => res(o.trim())); });
  const threads = await run(`ps -M ${host.pid} 2>/dev/null | tail -n +2 | wc -l | tr -d ' '`);
  const fds = await run(`lsof -p ${host.pid} 2>/dev/null | wc -l | tr -d ' '`);
  const rss = await run(`ps -o rss= -p ${host.pid} | tr -d ' '`);
  return { threads: Number(threads), fds: Number(fds), rssMb: Math.round(Number(rss) / 1024) };
};
const sock = connect(socket); await new Promise((r) => sock.once("connect", r));
let buf = ""; const pending = new Map();
sock.on("data", (b) => { buf += b; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} } });
const req = (msg) => new Promise((res) => { pending.set(msg.id, res); sock.write(JSON.stringify(msg) + "\n"); });
const marks = [0, 20];
const out = { base: await stats(), points: [] };
let opened = 0;
for (const target of marks.slice(1)) {
  while (opened < target) { opened += 1; const r = await req({ id: "o" + opened, type: "open_session", cwd: sandbox, sessionPath: join(sessionDir, "s" + opened + ".jsonl") }); if (r.success !== true) { out.error = { at: opened, reply: r }; break; } }
  out.points.push({ sessions: opened, ...(await stats()) });
  if (out.error) break;
}
const proto = await req({ id: "p", type: "get_protocol_info" });
out.protocol = { capabilities: proto?.data?.capabilities, serverVersion: proto?.data?.serverVersion };
out.hostArgv = "bun packages/coding-agent/src/cli.ts --mode rpc --multi-session --listen (in-process default for --listen)";
sock.destroy(); host.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
out.cleanup = { hostAlive: (() => { try { process.kill(host.pid, 0); return true; } catch { return false; } })() };
rmSync(sandbox, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
