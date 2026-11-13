<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-11-14 - A project write can state the folder it is for (senpi PR)

### What changed

- `set_project_trust`, `set_project_setting` and `write_project_file` take an optional `expectedCwd`. When it is given and the session's working directory is another folder (surrounding whitespace and trailing separators dropped on both sides), the write is refused with `project_cwd_mismatch` and nothing is written (`project-expected-cwd.ts`, checked in `connection-handler.ts` before dispatch). Without it, the write goes as before.
- Tests: `test/rpc/project-expected-cwd.test.ts`; the project-file host harness moved to `test/rpc/projectHost.ts`.

### Why

- A remote client reaches a session by a key that can since name another session. Reading the session's state and then writing is two requests, so the session can change between them; stating the folder on the write itself lets the engine refuse a write meant for another project.

### Must not break

- Absent `expectedCwd` is today's behaviour. `set_project_mcp_servers` and `write_project_skill_file` should take the same guard wherever they land.
