# TODO27 stop-hook verification 3

status: BLOCKED

worktree: `/Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w3`

started: `2026-07-08T06:42:17+0900`

## Direct checks

COMMAND: `git log -1 --oneline`

```text
8f48cb0a9 feat(coding-agent): oauth fixture idp + cross-process refresh race proof
```

COMMAND: `git show --name-only --oneline HEAD`

```text
8f48cb0a9 feat(coding-agent): oauth fixture idp + cross-process refresh race proof
.omo/evidence/task-27-senpi-mcp-plugin.log
.omo/evidence/todo-27-code-quality-slop-review.md
packages/coding-agent/test/mcp/fixtures/oauth-race-worker.ts
packages/coding-agent/test/mcp/oauth-race.test.ts
```

COMMAND: `tail -80 .omo/evidence/subagent-stop-22-todo27-verification-2.md`

```text
```

## Focused race test rerun

COMMAND: `cd packages/coding-agent && TODO27_RACE_ARTIFACT_DIR=../../local-ignore/qa-evidence/20260708-mcp-w3-todo27 npx tsx ../../node_modules/vitest/dist/cli.js --run test/mcp/oauth-race.test.ts`

```text

 RUN  v4.1.9 /Volumes/mengmotaStorage/local-workspaces/senpi-wt/senpi-mcp-plugin-w3/packages/coding-agent

·x

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/mcp/oauth-race.test.ts > cross-process refresh race > control case (lock OFF) trips family invalidation — the disaster the lock prevents
AssertionError: expected { discoveryState: { …(3) }, …(5) } to be undefined

- Expected:
undefined

+ Received:
{
  "accessToken": "<redacted:sentinel-at>",
  "codeVerifier": "aY3yD7fj2ieMDL5-HOL3mdc.r7QpHS_nHLihmFTBaSI",
  "discoveryState": {
    "authorizationServerMetadata": {
      "authorization_endpoint": "http://127.0.0.1:50338/authorize",
      "code_challenge_methods_supported": [
        "S256",
      ],
      "grant_types_supported": [
        "authorization_code",
        "refresh_token",
        "client_credentials",
      ],
      "issuer": "http://127.0.0.1:50338",
      "registration_endpoint": "http://127.0.0.1:50338/register",
      "response_types_supported": [
        "code",
      ],
      "scopes_supported": [
        "mcp",
        "offline_access",
      ],
      "token_endpoint": "http://127.0.0.1:50338/token",
      "token_endpoint_auth_methods_supported": [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
    },
    "authorizationServerUrl": "http://127.0.0.1:50338",
    "resourceMetadata": {
      "authorization_servers": [
        "http://127.0.0.1:50338",
      ],
      "resource": "http://127.0.0.1:50338/mcp",
    },
  },
  "expiresAt": 1783464089608,
  "refreshToken": "<redacted:sentinel-rt>",
  "resource": "http://127.0.0.1:50338/mcp",
}

 ❯ test/mcp/oauth-race.test.ts:175:18
    173|   // At least one process is left needing re-auth (invalid_grant).
    174|   expect(results.some((result) => result.ok === false && result.kind =…
    175|   expect(stored).toBeUndefined();
       |                  ^
    176|   raceArtifacts.push({
    177|    scenario: "lock-off",

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  06:41:28
   Duration  984ms (transform 46ms, setup 10ms, import 92ms, tests 801ms, environment 0ms)

```

COMMAND: `rg -n "AssertionError|expected .* to be undefined|Test Files  1 failed|SENTINEL_(AT|RT)_" .omo/evidence/subagent-stop-22-todo27-verification-2.md`

```text
53:AssertionError: expected { discoveryState: { …(3) }, …(5) } to be undefined
60:  "accessToken": "<redacted:sentinel-at>",
98:  "refreshToken": "<redacted:sentinel-rt>",
113: Test Files  1 failed (1)
```

COMMAND: `wc -c .omo/evidence/task-27-senpi-mcp-plugin.log .omo/evidence/todo-27-code-quality-slop-review.md local-ignore/qa-evidence/20260708-mcp-w3-todo27/INDEX.md local-ignore/qa-evidence/20260708-mcp-w3-todo27/cleanup-receipt.md`

```text
    6873 .omo/evidence/task-27-senpi-mcp-plugin.log
    3761 .omo/evidence/todo-27-code-quality-slop-review.md
    3951 local-ignore/qa-evidence/20260708-mcp-w3-todo27/INDEX.md
     132 local-ignore/qa-evidence/20260708-mcp-w3-todo27/cleanup-receipt.md
   14717 total
```

## Judgment

BLOCKED: TODO27 could not be claimed complete at this historical checkpoint. The re-verification evidence showed `test/mcp/oauth-race.test.ts` failed in the lock-off control: the shared store was expected to be undefined but still contained a token record. This sanitized copy preserves the failed Vitest diff context with raw fixture sentinel token values replaced by `<redacted:sentinel-at>` and `<redacted:sentinel-rt>`. No product/test files were modified during this third stop-hook response.
