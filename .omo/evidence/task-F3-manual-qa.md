# F3 manual QA evidence index

## Result

All required F3 lanes passed from the parity worktree with credential-isolated cells only. No real provider token, real Codex home, or port outside 18990-18999 was used.

## Artifacts

| Artifact | Verification result |
| --- | --- |
| `task-F3-differential.txt` | Full source-oracle matrix: `SCENARIOS_PASS=11/11 UNCLASSIFIED=0 REGRESSIONS=0`, `EXIT=0`. Each scenario records loopback-only fake-model use and post-cell port cleanup. |
| `task-F3-qa-app-server.txt` | Serialized runner passed its five probes: handshake, multiclient, approval, real-client, and real-client-sweep; `EXIT=0`. |
| `task-F3-client-smoke.txt` | Fresh Senpi cell on 18993. Separate `status`, `threads`, and `search qa` invocations each returned `EXIT=0`. The source-CLI wrapper's residual child was explicitly terminated by verified listener PID, then `CLEANUP_REPAIR_PORT_18993=empty` was recorded. |
| `task-F3-brew-oracle.txt` | Informational isolated brew release oracle: `codex-cli 0.144.5`, `oracle=release-0.144.5`, handshake pass, port 18994 empty, and cell removed. |
| `task-F3-cleanup.txt` | Final receipt: `LSOF_PORT_RANGE=empty` for 18990-18999 and `TEMP_SENPI_QA=empty` for `/tmp/senpi-qa*`. |
| `task-F3-evidence-copy-manifest.txt` | Complete `.omo/evidence` snapshot inventory and source-to-local-ignore copy verification. |

The complete evidence snapshot is copied to `local-ignore/qa-evidence/20260719-app-server-parity/`. The copy inventory artifact indexes all prior and final-wave evidence files, while this document indexes every artifact created by F3.
