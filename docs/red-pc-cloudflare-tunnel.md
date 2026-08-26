# RED PC public HTTPS with Cloudflare Tunnel

This optional Compose sidecar gives CollectFolio a stable HTTPS base URL even when RED PC is on another network. The one-command setup creates a named, locally managed Cloudflare Tunnel; an existing remotely managed connector-token tunnel remains supported as an advanced alternative. Both use outbound-only connectivity. No router port-forward or public RED PC port is required.

The resulting traffic path is:

```text
CollectFolio browser
  -> https://capture.example.com (Cloudflare TLS)
  -> named Cloudflare Tunnel
  -> cloudflared sidecar
  -> http://card-lookups:4100 (private Docker network)
```

Quick Tunnels generate temporary hostnames and are not suitable for CollectFolio's configured API base URL.

## Prerequisites

- A domain active on Cloudflare DNS. A single-label subdomain such as `capture.example.com` works with the usual edge certificate; Cloudflare documents extra certificate requirements for multi-level names such as `capture.home.example.com`.
- A Cloudflare account allowed to create a tunnel and DNS route for that domain.
- The three CollectFolio service addresses and a provider key only if using Groq or Ollama Cloud.
- Outbound DNS plus TCP and UDP port `7844` from Docker Desktop to Cloudflare Tunnel endpoints. No inbound firewall rule is needed. With the default `auto` transport, `cloudflared` prefers QUIC and falls back to HTTP/2 when UDP is unavailable.

The bootstrap installs Docker Desktop and downloads the repository. It also downloads the pinned `cloudflared` 2026.8.2 Windows client from Cloudflare's GitHub release, verifies its pinned SHA-256 digest and Windows publisher signature, and uses it only for account authorization and tunnel provisioning. The running connector is the pinned `cloudflare/cloudflared:2026.8.2` container image.

## Automatic setup from an empty RED PC

Paste the single command from the [RED PC Docker guide](red-pc-card-lookups.md) into PowerShell or Command Prompt. On the fifth screen, the guided assistant asks for the public hostname and shows it on a non-secret review screen. After confirmation, it opens `cloudflared tunnel login` in the browser, creates a computer-specific named tunnel, adds its DNS route without overwriting an existing record, and writes the ignored local files:

```text
%LOCALAPPDATA%\CollectCapture\app\.cloudflared\config.yml
%LOCALAPPDATA%\CollectCapture\app\.cloudflared\<TUNNEL-UUID>.json
```

The config contains a final catch-all ingress rule and sends only the selected hostname to `http://card-lookups:4100`. The credential JSON is never printed or placed in an environment variable. Compose mounts the ignored directory read-only into the connector container. On later starts, the double-click launcher validates and reuses the matching tunnel without another login; `red-pc-card-lookups.ps1 -Tunnel` detects this config and selects `compose.card-lookups.tunnel-local.yml` automatically.

The DNS route command intentionally does not use `--overwrite-dns`. If the requested hostname already has a record, setup leaves it untouched and offers to try a different hostname in the same guided run.

## Manual remotely managed alternative

Use this path only when a remotely managed tunnel already exists or its lifecycle must stay in the Cloudflare dashboard. It preserves the prior connector-token workflow.

1. In the Cloudflare dashboard, go to **Networking > Tunnels**, select **Create a tunnel**, and name it something recognizable such as `collectcapture-red-pc`.
2. Choose the Docker connector instructions. Cloudflare displays a command ending in `--token <TOKEN>`. Keep that page open and never commit or send the token to CollectFolio.
3. In the CollectCapture directory on RED PC, copy `.env.card-lookups.red-pc.example` to the ignored `.env.card-lookups.red-pc` file if it does not exist. Open the private copy in your preferred text editor and fill in its CollectFolio and selected-provider values.
4. Choose the stable hostname you will publish and add these values to the same private file:

```dotenv
CLOUDFLARE_TUNNEL_HOSTNAME=capture.example.com
CLOUDFLARE_TUNNEL_TOKEN=<paste the connector token only>
CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.8.2
COLLECTCAPTURE_BIND_ADDRESS=127.0.0.1
```

5. Double-click [`START-COLLECTCAPTURE-HTTPS.cmd`](../START-COLLECTCAPTURE-HTTPS.cmd) and choose the selected vision provider. The pre-start check validates the complete private file and preserves dashboard-managed token mode instead of opening browser tunnel registration. For command-line use, the equivalent is:

```powershell
.\red-pc-card-lookups.cmd -Provider Groq -Tunnel
```

Use `-Provider OllamaCloud -Tunnel`, or add `-Tunnel` to either local Ollama launcher form, if that is the qualified provider. The launcher rejects a missing token and rejects a URL or path in `CLOUDFLARE_TUNNEL_HOSTNAME` before starting Docker. Guided setup option 8 can later change the ordinary settings while preserving this token mode; if the hostname changes, update its Published application route in the Cloudflare dashboard too.

6. Wait for the tunnel to show **Healthy** in Cloudflare, then open its **Routes** tab and add a **Published application** route with:

```text
Hostname: capture.example.com
Service URL: http://card-lookups:4100
```

The service URL must use `card-lookups`, not `localhost`. From the sidecar, `localhost` means the `cloudflared` container itself and produces an origin error.

7. Save the route. Under the domain's **DNS > Records**, verify that the published hostname is proxied to the tunnel's `<UUID>.cfargotunnel.com` target. If you manage the record separately, it must be a proxied CNAME to that target.

Cloudflare serves the public edge certificate. The hop from `cloudflared` to the API remains HTTP because it never leaves the private Compose network. Do not enable a public port or configure a certificate inside the API container for this path.

## Connect CollectFolio

Use the public origin, with no route suffix, as CollectFolio's card-lookup API base URL:

```text
https://capture.example.com
```

`COLLECTFOLIO_APP_URL` in CollectCapture must still equal CollectFolio's exact browser origin, for example `https://folio.example.com`; it is not the tunnel hostname. CollectFolio must continue sending the signed-in user's Supabase bearer token to `POST /v1/card-lookups`.

For the manual path, the connector token authenticates RED PC to Cloudflare only. Never place it in browser code, a CollectFolio environment variable, a request header, an issue, or a log excerpt. For the automatic path, treat `.cloudflared/<TUNNEL-UUID>.json` with the same care.

## Verify from RED PC and another network

Check the local origin first:

```powershell
Invoke-RestMethod http://localhost:4100/health
```

Then inspect both containers and their startup logs:

```powershell
.\red-pc-card-lookups.cmd -Action Status -Provider Groq -Tunnel
.\red-pc-card-lookups.cmd -Action Logs -Provider Groq -Tunnel
```

The status should include `card-lookups` and `cloudflared`. The logs should show registered tunnel connections without failed DNS or port `7844` prechecks.

Finally, test the edge hostname from a device that is not on RED PC's network, such as a phone with Wi-Fi disabled:

```powershell
Invoke-RestMethod https://capture.example.com/health
```

Expect `{"status":"ok","service":"collectcapture-card-lookups"}`. Then perform an authenticated card scan in CollectFolio. The health request proves DNS, TLS, tunnel, and origin reachability; only the signed-in scan proves JWT, exact CORS, provider inference, and catalog connectivity end to end.

For an explicit browser preflight check, replace the two origins below with the real values:

```powershell
$headers = @{
  Origin = "https://folio.example.com"
  "Access-Control-Request-Method" = "POST"
  "Access-Control-Request-Headers" = "authorization,content-type"
}
Invoke-WebRequest `
  -Method Options `
  -Uri "https://capture.example.com/v1/card-lookups" `
  -Headers $headers
```

The response must allow the exact `Origin` value. Do not use `*` for authenticated browser requests. It also carries `Access-Control-Max-Age: 86400`, so a browser caches the preflight for 24 hours instead of repeating it before every scan.

## Security boundary

The published hostname is reachable from the Internet, but the card-lookup route remains protected by CollectCapture's Supabase JWT verification, exact-origin CORS policy, request-size limits, and rate limits. Every request through this sidecar shares one socket address at the API container, so `TRUSTED_PROXY_MODE=cloudflare-tunnel` (set by default in these overlays) keys the pre-auth rate limiter on Cloudflare's `Cf-Connecting-Ip` header instead — but only when the connecting socket is the private address the `cloudflared` sidecar itself uses, so a request that reaches the API any other way cannot forge that header to dodge the limit. This narrows, but does not remove, the exposure of a single shared bucket; add the edge rule below for real per-visitor limiting. The launcher does not create a Cloudflare Access application.

That choice avoids putting an Access service token in browser code. If Access is introduced later, design a browser-safe user authentication flow and verify CORS preflights and bearer-token forwarding before enabling it. Do not weaken CollectCapture's JWT checks because the request arrived through Cloudflare.

### Add a Cloudflare edge rate-limiting rule (recommended)

As defense in depth ahead of the application's own limits, add a Cloudflare rate-limiting rule on the published hostname: in the dashboard, go to **Security > WAF > Rate limiting rules**, create a rule scoped to the tunnel hostname, and start with something like 60 requests/minute per IP. This throttles abusive traffic at Cloudflare's edge before it ever reaches RED PC, independent of anything the API container can see about the connecting socket.

Keep `.env.card-lookups.red-pc` and `.cloudflared/` private; both are ignored by Git. If a manual connector token is exposed, rotate it in the Cloudflare dashboard and replace the local value. If a local credential JSON is exposed, delete and recreate that tunnel. The token should never appear in Compose command arguments; the manual sidecar receives it through its environment.

## Troubleshooting

- **Tunnel is not Healthy:** review the `cloudflared` logs and allow DNS plus outbound TCP/UDP `7844` to Cloudflare's documented tunnel endpoints. Cloudflare's [connectivity prechecks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/) list the current destinations.
- **Cloudflare returns an origin/502 error:** confirm the published service is exactly `http://card-lookups:4100` and the API container is running.
- **DNS/1016 error:** confirm the proxied CNAME targets this tunnel and that at least one connector is Healthy.
- **Browser reports CORS:** make `COLLECTFOLIO_APP_URL` match the browser's scheme, hostname, and port exactly, then restart the stack.
- **API returns 401:** check the CollectFolio Supabase issuer/JWKS values and confirm CollectFolio sends its current bearer token. This is separate from Cloudflare Tunnel authentication.
- **API returns 503 `authentication_unavailable`:** this means the box cannot reach the CollectFolio Supabase JWKS endpoint (network outage, DNS failure, or a slow/unreachable discovery URL), not that the token itself is invalid. Check RED PC's outbound connectivity to `COLLECTFOLIO_SUPABASE_URL`/`COLLECTFOLIO_SUPABASE_JWKS_URL` and retry after the `retry-after` window.
- **Hosted CollectFolio still calls HTTP:** change its card-lookup base URL to the tunnel's `https://` origin and redeploy CollectFolio through its owner; no CollectFolio files are changed by this setup.

## Disable or roll back

To stop public traffic immediately while leaving RED PC untouched, remove the Published application route (or its proxied DNS record) in Cloudflare. Then stop the current Compose project and restart locally without `-Tunnel`:

```powershell
.\red-pc-card-lookups.cmd -Action Down -Provider Groq
.\red-pc-card-lookups.cmd -Provider Groq
```

`Down` uses Compose orphan cleanup, so it removes the tunnel sidecar even when `-Tunnel` is omitted. This is useful if a credential has already been revoked. For permanent decommissioning, also delete or revoke the tunnel in Cloudflare. Manual installations can remove the two `CLOUDFLARE_TUNNEL_*` values; automatic installations can remove the ignored `.cloudflared` directory after the tunnel is deleted. Coordinate changing CollectFolio's API base URL with the agent or owner responsible for CollectFolio.

Official Cloudflare references used by this runbook:

- [Create a locally managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
- [Locally managed tunnel configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)
- [Create a remotely managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Published-application DNS records](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
- [Tunnel run token and transport parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)
- [Firewall destinations and ports](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)
