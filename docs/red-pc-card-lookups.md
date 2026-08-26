# RED PC card-lookups stack

This Docker Desktop stack runs only CollectCapture's stateless card-lookup API. It can use Groq, direct Ollama Cloud, or an Ollama server and vision model running on RED PC. It does not run or modify CollectFolio.

## Quick start on Windows

On an unconfigured 64-bit Windows 10 or Windows 11 RED PC, paste this one command into either PowerShell or Command Prompt:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;Invoke-WebRequest 'https://raw.githubusercontent.com/kaywhy331/CollectCapture/refs/heads/agent/collectcapture-card-lookup/bootstrap-red-pc.ps1' -OutFile ([IO.Path]::Combine([IO.Path]::GetTempPath(),'CollectCapture-bootstrap.ps1')) -UseBasicParsing;if((Get-FileHash -LiteralPath ([IO.Path]::Combine([IO.Path]::GetTempPath(),'CollectCapture-bootstrap.ps1')) -Algorithm SHA256).Hash -ne '0313e2d72b67bbd75234538f04dad3c4280e0b709b171b2760cc460be1ee1e73'){throw 'CollectCapture bootstrap checksum mismatch'};& ([IO.Path]::Combine([IO.Path]::GetTempPath(),'CollectCapture-bootstrap.ps1'))"
```

The signed-download bootstrap handles WSL 2, a per-user Docker Desktop install, repository download, guided private-server registration, Cloudflare Tunnel creation and DNS routing, Docker startup, local and public health checks, and a **CollectCapture HTTPS** desktop shortcut. It can register itself to resume after a required Windows restart. No Git, Node.js, package manager, repository clone, router port-forward, dashboard tunnel construction, or manual settings-file editing is required.

Some facts cannot be created safely by an installer. Keep these ready when the guided prompts ask for them:

- the CollectFolio browser origin, Supabase project URL, and catalog API URL;
- a Cloudflare account with a domain already active on Cloudflare DNS, followed by one browser authorization;
- a Groq or Ollama API key only when selecting that cloud provider.

Docker's license acceptance and Windows administrator approval for first-time WSL enablement also require an explicit click or answer. The bootstrap defaults to local Ollama, which needs no provider account or API key, and automatically selects NVIDIA acceleration when a compatible GPU is detected. On a lower-memory or CPU-only computer, Groq or Ollama Cloud is generally faster.

The setup assistant walks through five short screens:

1. **CollectFolio website:** enter the exact browser origin, such as `https://folio.example.com`. Do not include a page path.
2. **CollectFolio sign-in:** enter its Supabase Project URL. This is commonly the `VITE_SUPABASE_URL` value used by CollectFolio.
3. **Card catalog:** enter the catalog API base URL used by CollectFolio. A RED PC `localhost` address is translated automatically for Docker.
4. **Recognition provider:** choose local Ollama, Groq Cloud, or Ollama Cloud. Groq and Ollama keys are entered through a hidden prompt; local Ollama needs no provider key.
5. **Public HTTPS address:** enter an unused hostname under a domain already active on Cloudflare DNS, such as `capture.example.com`. The assistant then asks before opening Cloudflare browser authorization.

A review screen shows every non-secret setting before anything is written. Provider keys never appear in the review or console output. Approved values are stored only in the ignored `.env.card-lookups.red-pc` file on RED PC; browser-authorized tunnel credentials are stored only in the ignored `.cloudflared` directory.

If this repository is already present on RED PC, double-click [`INSTALL-COLLECTCAPTURE-RED-PC.cmd`](../INSTALL-COLLECTCAPTURE-RED-PC.cmd) for the same verified bootstrap. After installation, use the desktop shortcut or [`START-COLLECTCAPTURE-HTTPS.cmd`](../START-COLLECTCAPTURE-HTTPS.cmd) for routine starts, status, logs, and stops. Choosing a start option checks the saved values for that provider and opens the guided assistant only when something is missing. Menu option **8. Guided setup / change settings** walks through all five screens again; press Enter to retain a displayed value or an existing hidden key.

## Advanced command-line launcher

The lower-level launcher remains available for scripting. With Docker Desktop already running, choose one provider from PowerShell in the installed CollectCapture directory:

```powershell
# Fast cloud vision; this is the launcher default
.\red-pc-card-lookups.cmd -Provider Groq

# Direct Ollama Cloud API
.\red-pc-card-lookups.cmd -Provider OllamaCloud

# Private local inference on CPU
.\red-pc-card-lookups.cmd -Provider OllamaLocal

# Private local inference with an NVIDIA GPU
.\red-pc-card-lookups.cmd -Provider OllamaLocal -Nvidia

# Add a stable public HTTPS endpoint to any provider
.\red-pc-card-lookups.cmd -Provider Groq -Tunnel
```

The first lower-level invocation creates the ignored file `.env.card-lookups.red-pc` and stops. Without the bootstrap, fill in the three required CollectFolio connection values plus `GROQ_API_KEY` or `OLLAMA_API_KEY` for the selected cloud provider, then run the same command again. Local Ollama needs no model-provider key. `-Tunnel` auto-detects bootstrap-created local tunnel credentials; the manual remotely managed alternative additionally requires a connector token. Both paths are described in the [public HTTPS tunnel guide](red-pc-cloudflare-tunnel.md).

The local Ollama mode starts Ollama, persists models in a named Docker volume, pulls `qwen3.5:4b`, warms it, and only then starts the API. The first pull is several gigabytes and can take a while. Later starts reuse the model. `-Nvidia` requires Docker Desktop's WSL2 backend, a supported NVIDIA GPU, and a current Windows NVIDIA driver. Both local Ollama overlays set `OLLAMA_KEEP_ALIVE=-1` and every recognition request also asks for indefinite `keep_alive`, so the warmed model stays resident in RAM/VRAM by design instead of unloading between scans.

Useful commands retain the provider selection:

```powershell
.\red-pc-card-lookups.cmd -Action Status -Provider Groq
.\red-pc-card-lookups.cmd -Action Logs -Provider OllamaLocal
.\red-pc-card-lookups.cmd -Action Restart -Provider OllamaCloud
.\red-pc-card-lookups.cmd -Action Down -Provider OllamaLocal
.\red-pc-card-lookups.cmd -Action Status -Provider Groq -Tunnel
.\red-pc-card-lookups.cmd -Action Logs -Provider Groq -Tunnel
```

After startup, verify the API:

```powershell
Invoke-RestMethod http://localhost:4100/health
```

The expected response is `{"status":"ok","service":"collectcapture-card-lookups"}`.

## Provider choices

| Launcher mode | Default model      | Processing location | Output enforcement                                          |
| ------------- | ------------------ | ------------------- | ----------------------------------------------------------- |
| `Groq`        | `qwen/qwen3.6-27b` | Groq Cloud          | Groq JSON mode followed by strict local Zod validation      |
| `OllamaCloud` | `qwen3.5:397b`     | Ollama Cloud        | Native Ollama JSON Schema output followed by Zod validation |
| `OllamaLocal` | `qwen3.5:4b`       | RED PC              | Native Ollama JSON Schema output followed by Zod validation |

These defaults reflect the provider catalogs reviewed on August 21, 2026. Cloud models can be renamed or retired, so both model names are configurable in `.env.card-lookups.red-pc`. Ollama's local image defaults to `latest` because Qwen 3.5 needs a current Ollama build; after qualification, `OLLAMA_IMAGE` can be pinned to the tested image tag for reproducibility.

Local CPU inference is supported, but it may be too slow for the current CollectFolio client timeout. Allocate at least 8 GB of RAM to Docker; 12 GB or more is more comfortable for the default 4B model. An NVIDIA GPU with enough free VRAM improves latency substantially. Actual memory and latency depend on model tag, quantization, image dimensions, and context.

## Qualification with real cards

Vision support and valid JSON are necessary but do not prove card-recognition accuracy. Qualify every provider/model on the same representative crop set before selecting it.

1. Copy [the example manifest](card-recognition-benchmark.example.json) to a private folder as `manifest.json`.
2. Put the referenced JPEG, PNG, or WebP crops under that folder and replace the example expectations. Keep each image at or below 2 MiB.
3. Start the chosen stack, then run:

```powershell
.\red-pc-card-lookups.cmd `
  -Action Qualify `
  -Provider Groq `
  -QualificationDirectory C:\private\collectcapture-benchmark
```

The benchmark runs inside the API image, sequentially calls the configured recognition provider, and reports per-case, per-category (by game), and per-language pass/fail plus average latency, p95 latency, and the manifest's minimum pass rate -- enforced both overall AND per game category, so one weak category cannot hide behind a majority category's good results. The first case's latency is excluded from the average/p95 as warm-up (model load, connection setup). By default it does not call the catalog or retain an image. Repeat with `OllamaCloud` and `OllamaLocal`; use identical inputs and expectations.

Use at least 30–50 crops spanning the games, languages, layouts, foil glare, sleeves, camera quality, rotations, and partial/obscured fields CollectFolio will encounter. Include expected `null` fields to measure hallucinated set or collector-number claims. A reasonable initial gate is:

- at least 90% exact normalized field checks, overall and per game category;
- no systematic false set or collector-number claims on obscured cards;
- p95 recognition latency below roughly 25 seconds, leaving room for the current 30-second browser deadline;
- an end-to-end CollectFolio check that the correct catalog candidate is offered and still requires collector confirmation.

### Catalog-aware qualification

Recognition accuracy alone does not prove the search path actually surfaces the right catalog printing. Add an `expectedCatalog` block (`productId` and/or `name`, plus optional `setName`/`collectorNumber` and `topN`, default 5) to a manifest case -- see [the example manifest](card-recognition-benchmark.example.json) -- and run the harness with `--catalog` to additionally search the real catalog for that case and require the expected product to appear in the top `topN` results:

```powershell
docker compose -f compose.card-lookups.yml run --rm --no-deps `
  --volume C:\private\collectcapture-benchmark:/qualification:ro `
  --env CARD_LOOKUP_QUALIFICATION_TOKEN=<a-valid-collectfolio-bearer-token> `
  card-lookups `
  node dist/card-recognition-qualification.js /qualification/manifest.json --catalog
```

`--catalog` requires `COLLECTFOLIO_CATALOG_URL` (already configured for the stack) and a bearer token for a real CollectFolio session, supplied via `CARD_LOOKUP_QUALIFICATION_TOKEN` or `--token <value>`; missing either fails immediately with a clear error before any case runs. A case without `expectedCatalog` still runs its ordinary recognition-only check even with `--catalog` set. The `-Action Qualify` launcher shortcut above does not yet forward `--catalog`/`--token`; use the direct `docker compose run` form shown here until it does.

The code and mocked tests confirm that all three provider protocols can satisfy CollectCapture's recognition contract. Only a RED PC benchmark with representative crops can establish semantic accuracy and usable latency.

## Networking and local services

The API and local Ollama ports bind to `127.0.0.1` by default. Keep that setting when using `-Tunnel`: the `cloudflared` sidecar reaches the API over Docker's private network, so RED PC needs no public inbound port, router port-forward, or LAN-wide bind. Cloudflare terminates public TLS and forwards to `http://card-lookups:4100` inside the Compose project. See the [Cloudflare Tunnel setup and rollback runbook](red-pc-cloudflare-tunnel.md).

Without the tunnel, `COLLECTCAPTURE_BIND_ADDRESS=0.0.0.0` makes port 4100 reachable from the LAN, but it does not add TLS or network-edge authorization. A hosted HTTPS CollectFolio page also cannot call a plain HTTP LAN endpoint because browsers block mixed content.

Containers resolve host-side services through `host.docker.internal`. For a local catalog, for example, use `http://host.docker.internal:8787`. If local Supabase tokens contain the issuer `http://127.0.0.1:54321/auth/v1`, keep `COLLECTFOLIO_SUPABASE_URL=http://127.0.0.1:54321` for issuer validation and set `COLLECTFOLIO_SUPABASE_JWKS_URL=http://host.docker.internal:54321/auth/v1/.well-known/jwks.json` so the container can fetch keys.

## Privacy boundary

Local Ollama keeps model inference on RED PC. Groq and direct Ollama Cloud send the cropped card image to the selected provider, so their current data controls and account settings must be reviewed and disclosed. In every mode, CollectCapture keeps request bodies out of logs and does not write crops or recognition results to its database, object storage, or the Ollama model volume. `imageRetained: false` describes CollectCapture storage only; it is not a promise about a cloud provider's retention.

Implementation references reviewed for this stack:

- [Ollama vision](https://docs.ollama.com/capabilities/vision), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [Cloud API](https://docs.ollama.com/cloud), and [authentication](https://docs.ollama.com/api/authentication)
- [Ollama Qwen 3.5 model family](https://ollama.com/library/qwen3.5)
- [Groq vision models](https://console.groq.com/docs/vision), [structured/JSON output modes](https://console.groq.com/docs/structured-outputs), and [Qwen reasoning controls](https://console.groq.com/docs/reasoning)
