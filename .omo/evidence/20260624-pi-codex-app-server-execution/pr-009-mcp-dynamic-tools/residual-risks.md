# PR-009 Residual Risks

This work is using code-yeongyu/lazycodex teammode.

- PR-009 intentionally covers dynamic tool callbacks, MCP elicitation callbacks,
  MCP progress projection, structured content, `_meta`, and unsupported callback
  behavior only.
- Other app-server server requests such as auth refresh, attestation, and
  current time remain explicitly unsupported in this lane unless a later PR
  assigns them.
- PR-010 still owns reconnect/resume behavior.
- PR-011 still owns realtime/filesystem/plugin/config pass-through.
- PR-012 still owns the broad redaction QA harness.
- PR-013 still owns the final evidence packet.
