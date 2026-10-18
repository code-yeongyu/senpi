#!/usr/bin/env node
// C1 real-surface proof for senpi #1951: drive the REAL `senpi --mode rpc --multi-session`
// process over its stdio JSONL protocol and check the durable-session-id contract end to end.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, installCleanupHooks, makeSandbox, repoRoot } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { TargetRpcClient } from "../lib/target-rpc-client.mjs";

const CHOSEN = "0199f0d4-1c3a-7bb1-9d2e-0a1b2c3d4e5f";
const ON_DISK = "019ffe53-4359-7618-a61b-bc85786c94ef";

const headerIdOf = (path) => JSON.parse(readFileSync(path, "utf8").split("\n")[0]).id;

async function main() {
  installCleanupHooks();
  const checks = createChecks("durable session id (C1/C2/C3 real surface)");
  const box = makeSandbox("durable-id-qa");
  const env = hermeticEnv(box.env);
  const client = new TargetRpcClient({ env, cwd: box.cwd, targetRoot: repoRoot(), extraArgs: ["--multi-session"] });
  const out = [];
  const record = (label, value) => { const line = `${label}: ${JSON.stringify(value)}`; out.push(line); process.stdout.write(line + "\n"); };

  // C3: the host advertises the capability.
  const info = await client.send({ type: "get_protocol_info" });
  record("get_protocol_info.capabilities", info.data?.capabilities);
  checks.ok("advertises durable_session_id", (info.data?.capabilities ?? []).includes("durable_session_id"));

  // C1: create under a chosen id; the reply names it.
  const createdPath = join(box.sessionDir, "created.jsonl");
  const created = await client.send({ type: "open_session", cwd: box.cwd, sessionPath: createdPath, durableSessionId: CHOSEN });
  record("open_session(create, durableSessionId)", { success: created.success, error: created.error, durable: created.data?.state?.sessionId });
  checks.ok("create reply state.sessionId === chosen id", created.data?.state?.sessionId === CHOSEN, String(created.data?.state?.sessionId));
  const createdHandle = created.data?.sessionId;

  // C2: a second LIVE session under the same id is refused.
  const dup = await client.send({ type: "open_session", cwd: box.cwd, sessionPath: join(box.sessionDir, "dup.jsonl"), durableSessionId: CHOSEN });
  record("open_session(duplicate live id)", { success: dup.success, error: dup.error });
  checks.ok("duplicate live id -> session_id_in_use", dup.success === false && String(dup.error).includes("session_id_in_use"), String(dup.error));

  // C2: a malformed id is refused at the boundary.
  const bad = await client.send({ type: "open_session", cwd: box.cwd, sessionPath: join(box.sessionDir, "bad.jsonl"), durableSessionId: "no spaces allowed" });
  record("open_session(malformed id)", { success: bad.success, error: bad.error });
  checks.ok("malformed id -> invalid_session_id", bad.success === false && String(bad.error).includes("invalid_session_id"), String(bad.error));

  // C2: an EXISTING file keeps its header id even when a different id is offered.
  const existingPath = join(box.sessionDir, "existing.jsonl");
  writeFileSync(existingPath, JSON.stringify({ type: "session", version: 3, id: ON_DISK, timestamp: new Date().toISOString(), cwd: box.cwd }) + "\n");
  const resumed = await client.send({ type: "open_session", cwd: box.cwd, sessionPath: existingPath, durableSessionId: CHOSEN.replace("0a1b", "ffff") });
  record("open_session(existing file, different id offered)", { success: resumed.success, durable: resumed.data?.state?.sessionId });
  checks.ok("resume keeps the header id", resumed.data?.state?.sessionId === ON_DISK, String(resumed.data?.state?.sessionId));
  checks.ok("resume did not rewrite the header on disk", headerIdOf(existingPath) === ON_DISK, headerIdOf(existingPath));

  // C1 on disk: close the created session, reopen the same path with NO id, and the host
  // must read the chosen id back from the file header it wrote.
  if (createdHandle) await client.send({ type: "close_session", sessionId: createdHandle });
  const reopened = await client.send({ type: "open_session", cwd: box.cwd, sessionPath: createdPath });
  record("open_session(reopen created path, no id)", { success: reopened.success, durable: reopened.data?.state?.sessionId, fileExists: existsSync(createdPath) });
  checks.ok("reopen reads the chosen id back", reopened.data?.state?.sessionId === CHOSEN, String(reopened.data?.state?.sessionId));
  if (existsSync(createdPath)) {
    record("created.jsonl header id", headerIdOf(createdPath));
    checks.ok("chosen id is in the JSONL header on disk", headerIdOf(createdPath) === CHOSEN, headerIdOf(createdPath));
  } else {
    record("created.jsonl", "not materialized (no assistant message yet) - identity proven via reopen consistency");
  }

  // C2: once the holder is closed the id is free again.
  if (reopened.data?.sessionId) await client.send({ type: "close_session", sessionId: reopened.data.sessionId });
  const reused = await client.send({ type: "open_session", cwd: box.cwd, sessionPath: join(box.sessionDir, "reused.jsonl"), durableSessionId: CHOSEN });
  record("open_session(reuse id after close)", { success: reused.success, durable: reused.data?.state?.sessionId });
  checks.ok("id is reusable once its holder closed", reused.data?.state?.sessionId === CHOSEN, String(reused.data?.state?.sessionId));

  client.close();
  const outPath = process.argv[2] ?? "/tmp/senpi-1951-c1-proof.txt";
  writeFileSync(outPath, out.join("\n") + "\n");
  process.stdout.write(`evidence: ${outPath}\n`);
  checks.finish();
}
main().catch((error) => { console.error(error); process.exit(1); });
