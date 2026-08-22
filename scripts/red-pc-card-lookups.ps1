[CmdletBinding()]
param(
  [ValidateSet("Up", "Down", "Restart", "Logs", "Status", "Qualify")]
  [string]$Action = "Up",

  [ValidateSet("Groq", "OllamaCloud", "OllamaLocal")]
  [string]$Provider = "Groq",

  [switch]$Nvidia,

  [string]$QualificationDirectory = ""
)

$ErrorActionPreference = "Stop"
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$EnvironmentFile = Join-Path $RepositoryRoot ".env.card-lookups.red-pc"
$EnvironmentTemplate = Join-Path $RepositoryRoot ".env.card-lookups.red-pc.example"
$BaseComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.yml"
$LocalOllamaComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.ollama-local.yml"
$NvidiaComposeFile = Join-Path $RepositoryRoot "compose.card-lookups.nvidia.yml"

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
    throw "Docker was not found. Install and start Docker Desktop, then run this command again."
  }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose is unavailable. Update and start Docker Desktop, then try again."
  }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is installed but its engine is not running. Start Docker Desktop and try again."
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
