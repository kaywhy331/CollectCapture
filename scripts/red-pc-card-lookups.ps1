[CmdletBinding()]
param(
  [ValidateSet("Up", "Down", "Restart", "Logs", "Status", "Qualify")]
  [string]$Action = "Up",

  [ValidateSet("Groq", "OllamaCloud", "OllamaLocal")]
  [string]$Provider = "Groq",

  [switch]$Nvidia,

  [switch]$Tunnel,

  [string]$QualificationDirectory = ""
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$EnvironmentFile = Join-Path $RepositoryRoot ".env.card-lookups.red-pc"
$EnvironmentTemplate = Join-Path $RepositoryRoot ".env.card-lookups.red-pc.example"
$BaseComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.yml"
$LocalOllamaComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.ollama-local.yml"
$NvidiaComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.nvidia.yml"
$TunnelComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.tunnel.yml"
$LocalTunnelComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.tunnel-local.yml"
$LocalTunnelConfigFile = Join-Path $RepositoryRoot ".cloudflared\config.yml"

function Get-EnvironmentValue {
  param([Parameter(Mandatory = $true)][string]$Name)

  if (-not (Test-Path $EnvironmentFile)) { return "" }
  $match = Get-Content $EnvironmentFile | Where-Object {
    $_ -match "^\s*$([regex]::Escape($Name))\s*="
  } | Select-Object -Last 1
  if (-not $match) { return "" }
  return (($match -split "=", 2)[1]).Trim().Trim('"').Trim("'")
}

function Assert-DockerDesktop {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    $dockerCandidates = @(
      (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"),
      (Join-Path $env:LOCALAPPDATA "Docker\resources\bin\docker.exe")
    )
    $dockerPath = $dockerCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($dockerPath) {
      $env:Path = "$(Split-Path -Parent $dockerPath);$env:Path"
    } else {
      throw "Docker was not found. Run bootstrap-red-pc.ps1 or install and start Docker Desktop, then try again."
    }
  }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose is unavailable. Update and start Docker Desktop, then try again."
  }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    $desktopCandidates = @(
      (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
      (Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe")
    )
    $desktopPath = $desktopCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $desktopPath) {
      throw "Docker Desktop is installed but its engine is not running, and Docker Desktop.exe could not be found."
    }
    Write-Host "Starting Docker Desktop..."
    Start-Process -FilePath $desktopPath | Out-Null
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    while ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Seconds 5
      & docker info *> $null
      if ($LASTEXITCODE -eq 0) { return }
    }
    throw "Docker Desktop did not become ready within 10 minutes."
  }
}

function Assert-Configuration {
  $required = @(
    "COLLECTFOLIO_APP_URL",
    "COLLECTFOLIO_SUPABASE_URL",
    "COLLECTFOLIO_CATALOG_URL"
  )
  if ($Provider -eq "Groq") { $required += "GROQ_API_KEY" }
  if ($Provider -eq "OllamaCloud") { $required += "OLLAMA_API_KEY" }

  $missing = $required | Where-Object { -not (Get-EnvironmentValue $_) }
  if ($missing.Count -gt 0) {
    throw "Fill in these settings in $EnvironmentFile and run again: $($missing -join ', ')"
  }
}

function Assert-TunnelConfiguration {
  $required = @("CLOUDFLARE_TUNNEL_HOSTNAME")
  if (-not (Test-Path $LocalTunnelConfigFile)) {
    $required += "CLOUDFLARE_TUNNEL_TOKEN"
  }
  $missing = $required | Where-Object { -not (Get-EnvironmentValue $_) }
  if ($missing.Count -gt 0) {
    throw "Fill in these settings in $EnvironmentFile and run again: $($missing -join ', ')"
  }

  $hostname = Get-EnvironmentValue "CLOUDFLARE_TUNNEL_HOSTNAME"
  if (
    [Uri]::CheckHostName($hostname) -ne [System.UriHostNameType]::Dns -or
    -not $hostname.Contains(".")
  ) {
    throw "CLOUDFLARE_TUNNEL_HOSTNAME must be a DNS hostname such as cards.example.com, without https:// or a path."
  }

  if (Test-Path $LocalTunnelConfigFile) {
    $config = Get-Content $LocalTunnelConfigFile -Raw
    $credentialMatch = [Regex]::Match(
      $config,
      '(?m)^\s*credentials-file:\s*/etc/cloudflared/([^/\s]+\.json)\s*$'
    )
    if (-not $credentialMatch.Success) {
      throw "The locally managed tunnel config has no container credential path. Run the RED PC bootstrap again."
    }
    $credentialFile = Join-Path (Split-Path $LocalTunnelConfigFile) $credentialMatch.Groups[1].Value
    if (-not (Test-Path $credentialFile)) {
      throw "The locally managed tunnel credential is missing: $credentialFile. Run the RED PC bootstrap again."
    }
    $escapedHostname = [Regex]::Escape($hostname)
    if (
      $config -notmatch "(?m)^\s*-\s+hostname:\s*$escapedHostname\s*$" -or
      $config -notmatch '(?m)^\s*service:\s*http://card-lookups:4100\s*$' -or
      $config -notmatch '(?m)^\s*-\s+service:\s*http_status:404\s*$'
    ) {
      throw "The locally managed tunnel config does not match $hostname or lacks its safe ingress rules. Run the RED PC bootstrap again."
    }
  }
}

function Get-ComposeArguments {
  param([switch]$IncludeEveryService)

  $arguments = @(
    "compose",
    "--project-directory", $RepositoryRoot,
    "--env-file", $EnvironmentFile,
    "-f", $BaseComposeFile
  )
  if ($Provider -eq "OllamaLocal" -or $IncludeEveryService) {
    $arguments += @("-f", $LocalOllamaComposeFile)
  }
  if ($Nvidia) {
    $arguments += @("-f", $NvidiaComposeFile)
  }
  if ($Tunnel) {
    if (Test-Path $LocalTunnelConfigFile) {
      $arguments += @("-f", $LocalTunnelComposeFile)
    } else {
      $arguments += @("-f", $TunnelComposeFile)
    }
  }
  return $arguments
}

function Invoke-Compose {
  param(
    [Parameter(Mandatory = $true)][string[]]$CommandArguments,
    [switch]$IncludeEveryService
  )

  $composeArguments = Get-ComposeArguments -IncludeEveryService:$IncludeEveryService
  $allArguments = $composeArguments + $CommandArguments
  & docker @allArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose exited with code $LASTEXITCODE."
  }
}

if (-not (Test-Path $EnvironmentFile)) {
  Copy-Item $EnvironmentTemplate $EnvironmentFile
  Write-Host "Created $EnvironmentFile" -ForegroundColor Yellow
  Write-Host "Add the CollectFolio values and any key required by your chosen provider, then run this command again."
  exit 2
}

if ($Nvidia -and $Provider -ne "OllamaLocal") {
  throw "-Nvidia is only used with -Provider OllamaLocal. Cloud providers do not use RED PC's GPU."
}

if ($Tunnel) {
  Assert-TunnelConfiguration
}

Assert-DockerDesktop

switch ($Provider) {
  "Groq" {
    $env:CARD_RECOGNITION_PROVIDER = "groq"
  }
  "OllamaCloud" {
    $env:CARD_RECOGNITION_PROVIDER = "ollama"
    $env:OLLAMA_BASE_URL = "https://ollama.com"
  }
  "OllamaLocal" {
    $env:CARD_RECOGNITION_PROVIDER = "ollama"
  }
}

switch ($Action) {
  "Up" {
    Assert-Configuration
    Invoke-Compose -CommandArguments @("up", "--detach", "--build", "--remove-orphans")
    $port = Get-EnvironmentValue "COLLECTCAPTURE_PORT"
    if (-not $port) { $port = "4100" }
    Write-Host "CollectCapture is starting at http://localhost:$port/health"
    if ($Provider -eq "OllamaLocal") {
      $model = Get-EnvironmentValue "OLLAMA_LOCAL_MODEL"
      if (-not $model) { $model = "qwen3.5:4b" }
      Write-Host "The first start downloads and warms $model; watch progress with -Action Logs -Provider OllamaLocal."
    }
    if ($Tunnel) {
      $hostname = Get-EnvironmentValue "CLOUDFLARE_TUNNEL_HOSTNAME"
      Write-Host "Cloudflare Tunnel is starting for https://$hostname"
      if (Test-Path $LocalTunnelConfigFile) {
        Write-Host "The locally managed route targets http://card-lookups:4100."
      } else {
        Write-Host "Its published application route must target http://card-lookups:4100."
      }
    }
  }
  "Down" {
    Invoke-Compose -CommandArguments @("down", "--remove-orphans") -IncludeEveryService
  }
  "Restart" {
    Assert-Configuration
    Invoke-Compose -CommandArguments @("down", "--remove-orphans") -IncludeEveryService
    Invoke-Compose -CommandArguments @("up", "--detach", "--build", "--remove-orphans")
  }
  "Logs" {
    Invoke-Compose -CommandArguments @("logs", "--follow", "--tail", "200") -IncludeEveryService
  }
  "Status" {
    Invoke-Compose -CommandArguments @("ps", "--all") -IncludeEveryService
  }
  "Qualify" {
    Assert-Configuration
    if (-not $QualificationDirectory) {
      throw "-QualificationDirectory must point to a folder containing manifest.json and its card images."
    }
    $qualificationPath = (Resolve-Path $QualificationDirectory).Path
    if (-not (Test-Path (Join-Path $qualificationPath "manifest.json"))) {
      throw "The qualification directory must contain manifest.json."
    }
    $mount = "${qualificationPath}:/qualification:ro"
    Invoke-Compose -CommandArguments @(
      "run", "--rm", "--no-deps",
      "--volume", $mount,
      "card-lookups",
      "node", "dist/card-recognition-qualification.js", "/qualification/manifest.json"
    )
  }
}
