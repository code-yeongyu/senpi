# W5 e2e QA gate (todo 44) — verdicts

Date: 2026-07-08 · branch code-yeongyu/senpi-mcp-w5-skills-caps

| Step | Verdict | Evidence |
|---|---|---|
| skills sidecar: 0 pre-load exposure → includeTools reveal, union, system-wins | PASS | test/mcp/skills-sidecar.test.ts 4/4 (live stdio fixture registration) |
| proxy gateway: single tool, search→describe→call chain, bad-args guidance, nearest matches, auto-never | PASS | test/mcp/proxy-mode.test.ts 2/2 (real fixture round-trip) |
| resources: utility tools presence/absence, live list+read, binary guard, @mcp: mention e2e, malformed pass-through, updated-notification routing | PASS | test/mcp/resources.test.ts 5/5 |
| prompts → /mcp:fx:fixture_prompt: registration, arg collection, editor injection, required-arg abort | PASS | test/mcp/prompts-commands.test.ts 1/1 (live prompts/get) |
| elicitation: empty {} capability, typed accept, decline paths, timeout cancel | PASS | test/mcp/elicitation.test.ts 4/4 |
| progress + logging: level mapping, logLevel filter, flood cap | PASS | test/mcp/progress-logging.test.ts 3/3 (progress→onUpdate is W4 machinery, re-proven below) |
| docs: schema-vs-docs diff guard + disable instructions + no stale url-mode claim | PASS | scripts/check-mcp-docs.test.mjs 5/5 (guard proof: removing a field heading fails the diff test by construction) |
| FULL regression | PASS | npm run check EXIT 0 · test/mcp 265/265 · node --test scripts 45/45 |
| W1-W4 behavior smoke (exposure, promotion, rehydration, wire payloads) | PASS | w4-real-surface.mjs 8/8 on this branch (real CLI + real stdio fixture + fake model server) |

Notes: pre-existing exact-list assertions were hardened with withoutMcpUtilityTools()
(the todo-39 utility tools legitimately join every catalog that lists resources);
elicitation's timeout now rides wrap.ts safeTimer per the async-source guard.
