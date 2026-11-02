# Containerization

senpi runs with all permissions by default, but in some cases, you will want to have more control over what directories senpi can write to and which accesses it has.

There are two general options. You can either
1. run the whole `senpi` process inside an isolated environment, or
2. run `senpi` on the host and route tool execution into an isolated environment.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin extension | Built-in tools and `!` commands | Local micro-VM isolation while keeping auth on host | See [`examples/extensions/gondolin/`](../examples/extensions/gondolin/). |
| Plain Docker | Whole `senpi` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `senpi` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway |
| Docker Sandboxes | Whole `senpi` process in a managed sandbox | Local isolation with provider keys kept on the host | Requires Docker Sandboxes (`sbx`) and a kit that includes `senpi`. |

Extensions run wherever the `senpi` process runs. If you run host `senpi` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM.
Use the [example extension](../examples/extensions/gondolin) when you want `senpi` on the host but all built-in tools routed into the VM.

Setup:

```bash
cp -R packages/coding-agent/examples/extensions/gondolin ~/.senpi/agent/extensions/gondolin
cd ~/.senpi/agent/extensions/gondolin
bun add --ignore-scripts
```

Run from the project you want mounted:

```bash
cd /path/to/project
senpi -e ~/.senpi/agent/extensions/gondolin
```

The extension mounts the host cwd at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`.
User `!` commands are routed into the VM, as well.
File changes under `/workspace` write through to the host.

Requirements: Node.js >= 23.6.0 for `@earendil-works/gondolin`, plus QEMU (requires installation through your package manager).

## Plain Docker

Run the whole `senpi` process in Docker when you want the simplest local container boundary.

`Dockerfile.senpi`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN bun add -g --ignore-scripts @code-yeongyu/senpi

WORKDIR /workspace
ENTRYPOINT ["senpi"]
```

Build and run:

```bash
docker build -t senpi-sandbox -f Dockerfile.senpi .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v senpi-agent-home:/root/.senpi/agent \
  senpi-sandbox
```

The `-v "$PWD:/workspace"` mounts your current directory into the container at /workspace such that reads and writes in `/workspace` inside Docker directly affect your host files, like in the Gondolin example.

Use a named volume for `/root/.senpi/agent` if you want container-local settings and sessions. Mounting your host `~/.senpi/agent` exposes host auth and session files to the container.

## OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) when you want a policy-controlled sandbox with filesystem, process, network, credential, and inference controls.
OpenShell can run sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Every sandbox requires an active gateway.
Register and select one before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch `senpi` inside an OpenShell sandbox:

```bash
openshell sandbox create --name senpi-sandbox --from senpi -- senpi
```

In this pattern, the whole `senpi` process runs inside the sandbox.
Built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

If the gateway is remote, project files are not bind-mounted from the host, meaning writes in the sandbox are not reflected on your machine.
Clone the repository inside the sandbox or use OpenShell file transfer commands:

```bash
openshell sandbox upload senpi-sandbox ./repo /workspace
openshell sandbox download senpi-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox.
When inference routing is configured, code inside the sandbox can call `https://inference.local`, and the gateway injects the configured provider credentials upstream.
Configure senpi to use the corresponding OpenAI-compatible or Anthropic-compatible endpoint if you want model traffic to use this route.

## Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) is a managed sandbox runtime from Docker that runs the whole `senpi` process inside a sandbox.
It is one of the container boundaries [No Built-in Sandbox](security.md#no-built-in-sandbox) points to.

Unlike the Plain Docker pattern above, the provider credential is not passed into the container.
The sandbox receives a sentinel value instead, and the `sbx` proxy substitutes the real credential on egress to `api.anthropic.com`.
Credentials are wired at creation time, so store yours on the host before you create the sandbox.

For a Claude Pro/Max subscription, run `claude setup-token` on a machine with Claude Code, then store the result on the host.
If an `anthropic` secret is already bound, remove it first: otherwise the proxy adds an `x-api-key` header alongside the Bearer token and Anthropic rejects the request.
`sbx secret set-custom` reads the token from stdin, so it stays out of shell history.

```bash
sbx secret rm anthropic

sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

The sandbox gets an OAuth-shaped placeholder, not the real token, and the proxy swaps it on egress to that host; `ANTHROPIC_OAUTH_TOKEN` is a variable senpi already reads and prefers over an API key, so no extra senpi configuration is needed.

For an API key, store it with `sbx secret set anthropic` instead. The kit wires it the same way, as a sentinel the proxy substitutes on egress.

With the credential stored, launch `senpi` from the project you want mounted. The community `pi-kit` bakes upstream `pi` into its image, not `senpi`, so use a kit that installs `@code-yeongyu/senpi` (or install it inside the sandbox) and start `senpi` from it:

```bash
sbx run --kit "<your-senpi-kit>" senpi
```

The current directory becomes the sandbox workspace.

Do not authenticate from inside the sandbox: `/login` there writes a real token into the container and defeats the proxy model.

Scripted use works the same way:

```bash
sbx exec <sandbox-name> -- senpi -p "list the failing tests"
```

See the upstream [pi kit documentation](https://github.com/docker/sbx-kits-contrib/tree/main/pi) for the credential matrix, troubleshooting, and pinning; the same secret wiring applies to a `senpi` kit.
