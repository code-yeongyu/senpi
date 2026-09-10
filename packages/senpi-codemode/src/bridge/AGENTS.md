# src/bridge

## OVERVIEW

Kernel message schemas and the authenticated loopback HTTP bridge; score 9 for a distinct transport boundary with high protocol import fan-in.

## WHERE TO LOOK

| Task | Path |
| --- | --- |
| Host/kernel messages, decode errors | `protocol.ts` (`HostToKernelMessage`, `KernelToHostMessage`) |
| JSON-line framing and byte limit | `protocol.ts` (`parseBridgeJsonLine`, `decodeBridgeFrame`) |
| Token generation and comparison | `protocol.ts` (`generateBridgeToken`, `verifyBridgeToken`) |
| HTTP routes and disconnect cancellation | `http-server.ts` (`startBridgeServer`) |
| Reserved operation names | `reserved.ts`; dispatch is in `../bridges/reserved-dispatch.ts` |
| Transport regressions | `../../test/bridge-protocol.test.ts`, `../../test/bridge-server*.test.ts` |

## CONVENTIONS

- This protocol is not the remote-session CBOR package: kernel frames are JSON
  records terminated by LF; `BRIDGE_FRAME_MAX_BYTES` is 10 MiB, including the LF.
- `parseBridgeJsonLine` checks framing/JSON only; `decodeBridgeFrame` also checks
  TypeBox message schemas. A parsed value alone is not a validated message.
- The HTTP server binds `127.0.0.1` on an ephemeral port. POST routes are `/call`,
  `/emit`, and `/completion`; the default request-body cap is 1 MiB, not 10 MiB.
- Tokens are random base64url strings; verification compares SHA-256 digests
  with `timingSafeEqual`, allowing different input lengths without throwing.
- Handler failures use `{ ok: false, error }`; `/emit` success returns HTTP 204.
  Transport admission errors use HTTP 4xx; call/completion replies use HTTP 200.
- Response `close` aborts work only if `writableFinished` is false. Server close
  is idempotent and destroys tracked sockets before awaiting shutdown.

## ANTI-PATTERNS

- Do not use request `close` as a disconnect signal: Node emits it on normal
  request completion too; cancellation belongs to the unfinished response.
- Do not collapse frame-size and HTTP-body limits into one setting.
- Do not replace digest comparison with direct bearer-token string equality.
- Do not move task-tool implementations into this layer; `../bridges/` owns
  agent/output/schema adapters, while kernels own execution and recovery.
