# Mandate MCP server

Lets an AI agent spend from a Mandate treasury as a native tool, instead of hand-rolling `curl`
calls and guessing endpoint shapes.

The intended flow, end to end:

```
human creates a policy and an API key  ->  hands the key to an agent
      ->  agent calls Mandate tools  ->  vault enforces policy on chain  ->  BOT transaction
```

The vault decides whether money moves. The agent can ask; it cannot make a payment happen that policy
forbids, and it never holds funds.

## Setup

The server needs one agent key, issued from **Agents -> API credentials** in the dashboard, and the
base URL of a running Mandate deployment.

```bash
export MANDATE_API_KEY=mdt_...
export MANDATE_API_BASE=http://localhost:3000
npm run mcp
```

The key is read from the environment only. No tool accepts a key or a URL, so a prompt injection
cannot redirect this server at another host or another treasury.

## Client configuration

**Claude Desktop / Claude Code** - `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mandate": {
      "command": "node",
      "args": ["/absolute/path/to/Mandate/web/mcp/server.mjs"],
      "env": {
        "MANDATE_API_KEY": "mdt_...",
        "MANDATE_API_BASE": "https://your-mandate-host"
      }
    }
  }
}
```

**Cursor** - `.cursor/mcp.json`, same shape. **Any other MCP client**: stdio transport, same
`command`/`args`/`env` triple.

## Hosting it instead

stdio means every client spawns its own process, which no client that can only reach a network
endpoint can use. For a hosted deployment the same server speaks Streamable HTTP:

```bash
MANDATE_MCP_TRANSPORT=http MANDATE_MCP_PORT=8787 \
MANDATE_API_KEY=mdt_... MANDATE_API_BASE=https://your-mandate-host \
node mcp/server.mjs
```

Or with the included image, which installs nothing - the server imports only `node:crypto` and
`node:readline`:

```bash
docker buildx build --load -f Dockerfile.mcp -t mandate-mcp .

docker run -p 8787:8787 \
  -e MANDATE_API_KEY=mdt_... \
  -e MANDATE_API_BASE=https://your-mandate-host \
  mandate-mcp
```

`POST /mcp` carries one JSON-RPC message or a batch. `GET /healthz` is a dependency-free readiness
probe.

**It is not stateless.** A session id is issued by `initialize` and required on every later request;
requests without a live session get `403`. That is deliberate - a stateless endpoint reachable over
a network that can move money would undo the key-scoped design, since anyone who found the port could
call `request_payment`. Sessions expire after 30 minutes.

Both transports are covered by `npm run mcp:check`.

## Tools

| Tool | Does | Notes |
|------|------|-------|
| `get_budget` | Reads your live leash | caps in base units *and* as tUSDT, whether an owner signature is required, vault balance |
| `check_spend` | Would this be permitted? | Sends nothing. Cannot know the recipient allowlist, and says so |
| `request_payment` | Requests a payment | Returns the chain's verdict. A refusal is data, not an error |
| `settle_payment` | Settles an approved request | Only needed when the policy requires an owner signature |
| `get_request` | Reads one request from chain | Current status |
| `list_rejections` | Recent refusals, with reasons | The only trace of a rejection, since a refusal reverts and emits nothing |

## Design notes

**A refusal is a successful tool call.** When the vault rejects a payment the tool returns
`accepted: false` with the decoded reason (`InvalidPolicy`, `NotAuthorized`, ...) and a `nextStep`
telling the model not to retry with a larger or split amount. Returning an error instead would make
a policy decision look like a malfunction, which is exactly the behaviour that produces agents trying
to route around a limit.

**Amounts are integer base units as strings.** `2.5` is rejected with an explanation rather than
rounded. `2500000` is 2.5 tUSDT. Silent rounding of a spending amount is how a limit becomes a
suggestion.

**Idempotency is surfaced, not hidden.** `request_payment` generates a 32-byte key when you omit one
and always returns it, so an agent that retries after a timeout reuses the same key and gets the same
request rather than a second payment. Verified: three identical calls produce one request and move no
funds.

**Requests are handled strictly in order.** Two concurrent spends interleaving key generation would be
a real hazard, and serialising costs nothing at human request rates.

## Verification

```bash
npm run mcp:check
```

Spawns the real server twice - once on stdio, once on HTTP - against a fake API, so the protocol
layer is checked without spending money or needing the dashboard running. Covers the handshake, the
content envelope, refusal-as-data, float rejection, the dry run, error codes, that stdout carries only
protocol frames, and that the HTTP transport refuses tool calls without a live session.

44 checks.