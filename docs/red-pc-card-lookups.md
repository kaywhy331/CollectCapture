# RED PC card-lookups stack

This Docker Desktop stack runs only CollectCapture's stateless card-lookup API. It can use Groq, direct Ollama Cloud, or an Ollama server and vision model running on RED PC. It does not run or modify CollectFolio.

## Quick start on Windows

Install and start a current Docker Desktop release. From PowerShell in the CollectCapture repository, choose one provider:

```powershell
# Fast cloud vision; this is the launcher default
.\red-pc-card-lookups.cmd -Provider Groq

# Direct Ollama Cloud API
.\red-pc-card-lookups.cmd -Provider OllamaCloud

# Private local inference on CPU
.\red-pc-card-lookups.cmd -Provider OllamaLocal

# Private local inference with an NVIDIA GPU
.\red-pc-card-lookups.cmd -Provider OllamaLocal -Nvidia
```

The first invocation creates the ignored file `.env.card-lookups.red-pc` and stops. Fill in the three required CollectFolio connection values plus `GROQ_API_KEY` or `OLLAMA_API_KEY` for the selected cloud provider, then run the same command again. Local Ollama needs no model-provider key.

The local Ollama mode starts Ollama, persists models in a named Docker volume, pulls `qwen3.5:4b`, warms it, and only then starts the API. The first pull is several gigabytes and can take a while. Later starts reuse the model. `-Nvidia` requires Docker Desktop's WSL2 backend, a supported NVIDIA GPU, and a current Windows NVIDIA driver.

Useful commands retain the provider selection:

```powershell
.\red-pc-card-lookups.cmd -Action Status -Provider Groq
.\red-pc-card-lookups.cmd -Action Logs -Provider OllamaLocal
.\red-pc-card-lookups.cmd -Action Restart -Provider OllamaCloud
.\red-pc-card-lookups.cmd -Action Down -Provider OllamaLocal
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

The benchmark runs inside the API image, sequentially calls the configured recognition provider, and reports per-field failures, average latency, p95 latency, and the manifest's minimum pass rate. It does not call the catalog or retain an image. Repeat with `OllamaCloud` and `OllamaLocal`; use identical inputs and expectations.

Use at least 30–50 crops spanning the games, languages, layouts, foil glare, sleeves, camera quality, rotations, and partial/obscured fields CollectFolio will encounter. Include expected `null` fields to measure hallucinated set or collector-number claims. A reasonable initial gate is:

- at least 90% exact normalized field checks;
- no systematic false set or collector-number claims on obscured cards;
- p95 recognition latency below roughly 25 seconds, leaving room for the current 30-second browser deadline;
- an end-to-end CollectFolio check that the correct catalog candidate is offered and still requires collector confirmation.

The code and mocked tests confirm that all three provider protocols can satisfy CollectCapture's recognition contract. Only a RED PC benchmark with representative crops can establish semantic accuracy and usable latency.

## Networking and local services

The API and local Ollama ports bind to `127.0.0.1` by default. This is the safe choice when CollectFolio runs in a browser on RED PC. `COLLECTCAPTURE_BIND_ADDRESS=0.0.0.0` makes port 4100 reachable from the LAN, but it does not add TLS or authentication at the network edge. A hosted HTTPS CollectFolio page also cannot call a plain HTTP LAN endpoint because browsers block mixed content. Use a reviewed HTTPS reverse proxy or tunnel and firewall policy before exposing RED PC.

Containers resolve host-side services through `host.docker.internal`. For a local catalog, for example, use `http://host.docker.internal:8787`. If local Supabase tokens contain the issuer `http://127.0.0.1:54321/auth/v1`, keep `COLLECTFOLIO_SUPABASE_URL=http://127.0.0.1:54321` for issuer validation and set `COLLECTFOLIO_SUPABASE_JWKS_URL=http://host.docker.internal:54321/auth/v1/.well-known/jwks.json` so the container can fetch keys.

## Privacy boundary

Local Ollama keeps model inference on RED PC. Groq and direct Ollama Cloud send the cropped card image to the selected provider, so their current data controls and account settings must be reviewed and disclosed. In every mode, CollectCapture keeps request bodies out of logs and does not write crops or recognition results to its database, object storage, or the Ollama model volume. `imageRetained: false` describes CollectCapture storage only; it is not a promise about a cloud provider's retention.

Implementation references reviewed for this stack:

- [Ollama vision](https://docs.ollama.com/capabilities/vision), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [Cloud API](https://docs.ollama.com/cloud), and [authentication](https://docs.ollama.com/api/authentication)
- [Ollama Qwen 3.5 model family](https://ollama.com/library/qwen3.5)
- [Groq vision models](https://console.groq.com/docs/vision), [structured/JSON output modes](https://console.groq.com/docs/structured-outputs), and [Qwen reasoning controls](https://console.groq.com/docs/reasoning)
