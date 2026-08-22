#requires -Version 5.1

[CmdletBinding()]
param(
  [switch]$Resume,
  [switch]$Reconfigure,
  [string]$Provider = "",
  [string]$InstallRoot = "",
  [string]$RepositoryRef = "agent/collectcapture-card-lookup"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$RepositoryOwner = "kaywhy331"
$RepositoryName = "CollectCapture"
$CloudflaredVersion = "2026.8.2"
$CloudflaredSha256 = "c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5"
$DockerDesktopUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
$RunOnceName = "CollectCaptureRedPcBootstrap"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not $InstallRoot) {
  $InstallRoot = Join-Path $env:LOCALAPPDATA "CollectCapture"
}

$ApplicationDirectory = Join-Path $InstallRoot "app"
$ToolsDirectory = Join-Path $InstallRoot "tools"
$StateDirectory = Join-Path $InstallRoot "state"
$StateFile = Join-Path $StateDirectory "bootstrap-state.json"
$PersistedBootstrap = Join-Path $StateDirectory "bootstrap-red-pc.ps1"
$CloudflaredPath = Join-Path $ToolsDirectory "cloudflared.exe"
$EnvironmentFile = Join-Path $ApplicationDirectory ".env.card-lookups.red-pc"
$EnvironmentTemplate = Join-Path $ApplicationDirectory ".env.card-lookups.red-pc.example"
$LocalTunnelDirectory = Join-Path $ApplicationDirectory ".cloudflared"
$LocalTunnelConfig = Join-Path $LocalTunnelDirectory "config.yml"
$TemporaryDirectory = ""

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)

  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Success {
  param([Parameter(Mandatory = $true)][string]$Message)

  Write-Host $Message -ForegroundColor Green
}

function Read-Confirmation {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [bool]$DefaultYes = $true
  )

  $suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $answer = (Read-Host "$Prompt $suffix").Trim()
    if (-not $answer) { return $DefaultYes }
    if ($answer -match "^(?i:y|yes)$") { return $true }
    if ($answer -match "^(?i:n|no)$") { return $false }
    Write-Host "Enter Y or N."
  }
}

function New-ExactTemporaryDirectory {
  $path = Join-Path ([IO.Path]::GetTempPath()) ("CollectCapture-" + [Guid]::NewGuid().ToString("N"))
  [IO.Directory]::CreateDirectory($path) | Out-Null
  return $path
}

function Save-PersistedBootstrap {
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  if (-not $PSCommandPath) {
    throw "This bootstrap must be run from its downloaded .ps1 file."
  }
  if (-not ([IO.Path]::GetFullPath($PSCommandPath)).Equals(
      [IO.Path]::GetFullPath($PersistedBootstrap),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    Copy-Item -LiteralPath $PSCommandPath -Destination $PersistedBootstrap -Force
  }
}

function Register-BootstrapResume {
  Save-PersistedBootstrap
  $powerShellPath = (Get-Process -Id $PID).Path
  $command = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" -Resume -InstallRoot "{2}" -RepositoryRef "{3}"' -f `
    $powerShellPath.Replace('"', '\"'), `
    $PersistedBootstrap.Replace('"', '\"'), `
    $InstallRoot.Replace('"', '\"'), `
    $RepositoryRef.Replace('"', '\"')
  $runOncePath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
  if (-not (Test-Path $runOncePath)) {
    New-Item -Path $runOncePath -Force | Out-Null
  }
  New-ItemProperty -Path $runOncePath -Name $RunOnceName -Value $command -PropertyType String -Force | Out-Null
}

function Clear-BootstrapResume {
  $runOncePath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
  Remove-ItemProperty -Path $runOncePath -Name $RunOnceName -ErrorAction SilentlyContinue
}

function Request-RestartAndResume {
  param([Parameter(Mandatory = $true)][string]$Reason)

  Register-BootstrapResume
  Write-Host ""
  Write-Host $Reason -ForegroundColor Yellow
  Write-Host "Setup will resume automatically after you sign back into Windows."
  if (Read-Confirmation "Restart RED PC now?" $true) {
    Start-Process -FilePath "$env:SystemRoot\System32\shutdown.exe" -ArgumentList @("/r", "/t", "5")
    exit 0
  }
  Write-Host "Restart Windows when ready. Setup is registered to resume after sign-in."
  exit 0
}

function Assert-SupportedWindows {
  if ($env:OS -ne "Windows_NT") {
    throw "This bootstrap is for 64-bit Windows 10 or Windows 11 on RED PC."
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw "Docker Desktop and this bootstrap require 64-bit Windows."
  }

  try {
    $memoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $memoryGiB = [Math]::Round($memoryBytes / 1GB, 1)
    Write-Host "Detected $memoryGiB GiB of system memory."
    if ($memoryGiB -lt 8) {
      Write-Warning "Local Ollama normally needs at least 8 GiB. Choose Groq or Ollama Cloud during setup."
    }
  } catch {
    Write-Warning "Could not read installed memory; setup will continue."
  }
}

function Invoke-ElevatedWslEnablement {
  $commands = @'
$restartRequired = $false
foreach ($feature in @("Microsoft-Windows-Subsystem-Linux", "VirtualMachinePlatform")) {
  & dism.exe /online /enable-feature "/featurename:$feature" /all /norestart
  if ($LASTEXITCODE -eq 3010) { $restartRequired = $true; continue }
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if ($restartRequired) { exit 3010 }
exit 0
'@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($commands))
  $powerShellPath = (Get-Process -Id $PID).Path
  Write-Host "Windows will ask for administrator approval to enable WSL 2 components."
  $process = Start-Process `
    -FilePath $powerShellPath `
    -Verb RunAs `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded) `
    -Wait `
    -PassThru
  if ($process.ExitCode -notin @(0, 3010)) {
    throw "Windows could not enable WSL 2 components (exit $($process.ExitCode))."
  }
  return $process.ExitCode
}

function Test-WslReady {
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return $false }
  & wsl.exe --status *> $null
  return ($LASTEXITCODE -eq 0)
}

function Ensure-WslReady {
  Write-Step "Checking the Windows WSL 2 foundation"
  if (-not (Test-WslReady)) {
    if ($Resume) {
      & wsl.exe --update
      if (-not (Test-WslReady)) {
        throw "WSL 2 is still unavailable after restart. Install current Windows updates and confirm CPU virtualization is enabled, then rerun setup."
      }
    } else {
      $null = Invoke-ElevatedWslEnablement
      Request-RestartAndResume "Windows enabled the WSL 2 components and needs one restart before Docker can start."
    }
  }

  & wsl.exe --set-default-version 2 *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "WSL is present but could not select version 2. Install current Windows updates and rerun this command."
  }
  & wsl.exe --update
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "WSL's update command did not complete. Docker Desktop may finish the update during startup."
  }
  Write-Success "WSL 2 is ready."
}

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Destination
  )

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
  Unblock-File -LiteralPath $Destination -ErrorAction SilentlyContinue
}

function Assert-AuthenticodePublisher {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$PublisherPattern
  )

  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Windows could not validate the digital signature on $(Split-Path $Path -Leaf): $($signature.Status)."
  }
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch $PublisherPattern) {
    throw "$(Split-Path $Path -Leaf) was signed by an unexpected publisher."
  }
}

function Find-DockerExecutable {
  $command = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin\docker.exe"),
    (Join-Path $env:LOCALAPPDATA "Docker\resources\bin\docker.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return ""
}

function Add-DockerToProcessPath {
  param([Parameter(Mandatory = $true)][string]$DockerPath)

  $directory = Split-Path -Parent $DockerPath
  if (($env:Path -split ";") -notcontains $directory) {
    $env:Path = "$directory;$env:Path"
  }
}

function Install-DockerDesktop {
  Write-Step "Installing Docker Desktop"
  Write-Host "Docker Desktop is governed by Docker's current subscription and service terms."
  Write-Host "The installer cannot legally accept those terms for you."
  if (-not (Read-Confirmation "Have you reviewed and do you accept Docker Desktop's terms?" $false)) {
    throw "Docker Desktop terms were not accepted, so setup stopped before installation."
  }

  $installer = Join-Path $TemporaryDirectory "Docker Desktop Installer.exe"
  Write-Host "Downloading the official Docker Desktop installer..."
  Invoke-Download -Uri $DockerDesktopUrl -Destination $installer
  Assert-AuthenticodePublisher -Path $installer -PublisherPattern "Docker"

  Write-Host "Running Docker's signed per-user installer. This can take several minutes."
  $process = Start-Process `
    -FilePath $installer `
    -ArgumentList @("install", "--quiet", "--accept-license", "--backend=wsl-2", "--user") `
    -Wait `
    -PassThru
  if ($process.ExitCode -eq 3010) {
    Request-RestartAndResume "Docker Desktop installed successfully and Windows requested a restart."
  }
  if ($process.ExitCode -ne 0) {
    throw "Docker Desktop installation failed with exit code $($process.ExitCode)."
  }
}

function Start-DockerDesktop {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
    (Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      Start-Process -FilePath $candidate | Out-Null
      return
    }
  }
  throw "Docker's command was installed, but Docker Desktop.exe could not be found."
}

function Wait-ForDockerEngine {
  param([Parameter(Mandatory = $true)][string]$DockerPath)

  Write-Host "Waiting for the Docker engine to become ready..."
  $deadline = [DateTime]::UtcNow.AddMinutes(10)
  $nextUpdate = [DateTime]::UtcNow
  while ([DateTime]::UtcNow -lt $deadline) {
    & $DockerPath info *> $null
    if ($LASTEXITCODE -eq 0) {
      & $DockerPath compose version *> $null
      if ($LASTEXITCODE -ne 0) {
        throw "Docker started, but the Compose plugin is unavailable. Update Docker Desktop and rerun setup."
      }
      Write-Success "Docker Desktop is running."
      return
    }
    if ([DateTime]::UtcNow -ge $nextUpdate) {
      Write-Host "  Docker is still starting..."
      $nextUpdate = [DateTime]::UtcNow.AddSeconds(30)
    }
    Start-Sleep -Seconds 5
  }
  throw "Docker did not start within 10 minutes. Confirm hardware virtualization is enabled in RED PC's firmware, then rerun setup."
}

function Ensure-DockerDesktop {
  Write-Step "Checking Docker Desktop"
  $dockerPath = Find-DockerExecutable
  if (-not $dockerPath) {
    Install-DockerDesktop
    $dockerPath = Find-DockerExecutable
  }
  if (-not $dockerPath) {
    throw "Docker Desktop installation finished, but docker.exe was not found. Restart Windows and rerun setup."
  }
  Add-DockerToProcessPath -DockerPath $dockerPath

  & $dockerPath info *> $null
  if ($LASTEXITCODE -ne 0) {
    Start-DockerDesktop
  }
  Wait-ForDockerEngine -DockerPath $dockerPath
}

function Install-CollectCaptureFiles {
  Write-Step "Downloading CollectCapture"
  $archive = Join-Path $TemporaryDirectory "CollectCapture.zip"
  $expanded = Join-Path $TemporaryDirectory "repository"
  $archiveUrl = "https://github.com/$RepositoryOwner/$RepositoryName/archive/refs/heads/$RepositoryRef.zip"
  Invoke-Download -Uri $archiveUrl -Destination $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $expanded -Force
  $source = Get-ChildItem -LiteralPath $expanded -Directory | Select-Object -First 1
  if (-not $source -or -not (Test-Path (Join-Path $source.FullName "START-COLLECTCAPTURE-HTTPS.cmd"))) {
    throw "The downloaded CollectCapture archive did not contain the expected launcher."
  }

  [IO.Directory]::CreateDirectory($ApplicationDirectory) | Out-Null
  Get-ChildItem -LiteralPath $source.FullName -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $ApplicationDirectory -Recurse -Force
  }
  Write-Success "CollectCapture is installed in $ApplicationDirectory"
}

function Get-EnvironmentValues {
  $values = @{}
  if (-not (Test-Path $EnvironmentFile)) { return $values }
  foreach ($line in [IO.File]::ReadAllLines($EnvironmentFile)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $value = $Matches[2].Trim()
      if (
        $value.Length -ge 2 -and
        (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$Matches[1]] = $value
    }
  }
  return $values
}

function Read-RequiredUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [string]$CurrentValue = "",
    [switch]$OriginOnly
  )

  while ($true) {
    $label = if ($CurrentValue) { "$Prompt [$CurrentValue]" } else { $Prompt }
    $answer = (Read-Host $label).Trim()
    if (-not $answer) { $answer = $CurrentValue }
    [Uri]$parsed = $null
    if (-not [Uri]::TryCreate($answer, [UriKind]::Absolute, [ref]$parsed)) {
      Write-Host "Enter a complete http:// or https:// URL."
      continue
    }
    if ($parsed.Scheme -notin @("http", "https") -or -not $parsed.Host) {
      Write-Host "Only a complete http:// or https:// URL is supported."
      continue
    }
    if ($parsed.Query -or $parsed.Fragment -or ($OriginOnly -and $parsed.AbsolutePath -ne "/")) {
      Write-Host "Enter only the service origin, without a path, query, or fragment."
      continue
    }
    return $answer.TrimEnd("/")
  }
}

function Read-RequiredHostname {
  param([string]$CurrentValue = "")

  while ($true) {
    $label = if ($CurrentValue) {
      "Public Cloudflare hostname [$CurrentValue]"
    } else {
      "Public Cloudflare hostname (example: capture.example.com)"
    }
    $hostname = (Read-Host $label).Trim().ToLowerInvariant()
    if (-not $hostname) { $hostname = $CurrentValue }
    if (
      $hostname -and
      [Uri]::CheckHostName($hostname) -eq [UriHostNameType]::Dns -and
      $hostname.Contains(".")
    ) {
      return $hostname
    }
    Write-Host "Enter a DNS hostname only, without https://, a port, or a path."
  }
}

function Read-SecretValue {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  while ($true) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [IntPtr]::Zero
    try {
      $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
      if ($plain -and $plain -notmatch '\s') { return $plain }
    } finally {
      if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
      }
    }
    Write-Host "The key cannot be empty or contain whitespace."
  }
}

function Get-SavedProvider {
  if (-not (Test-Path $StateFile)) { return "" }
  try {
    $state = [IO.File]::ReadAllText($StateFile) | ConvertFrom-Json
    if ($state.provider -in @("Groq", "OllamaCloud", "OllamaLocal")) {
      return [string]$state.provider
    }
  } catch {
    return ""
  }
  return ""
}

function Select-RecognitionProvider {
  if ($Provider) { return $Provider }
  $saved = Get-SavedProvider
  if ($saved -and -not $Reconfigure) { return $saved }

  Write-Host ""
  Write-Host "Choose the vision provider CollectCapture should start now:"
  Write-Host "  1. Local Ollama (default; no AI account or key, larger download)"
  Write-Host "  2. Groq Cloud (fast startup; requires a Groq API key)"
  Write-Host "  3. Ollama Cloud (requires an Ollama API key)"
  while ($true) {
    $choice = (Read-Host "Provider [1]").Trim()
    if (-not $choice -or $choice -eq "1") { return "OllamaLocal" }
    if ($choice -eq "2") { return "Groq" }
    if ($choice -eq "3") { return "OllamaCloud" }
    Write-Host "Enter 1, 2, or 3."
  }
}

function Set-EnvironmentValues {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$Updates)

  if (-not (Test-Path $EnvironmentFile)) {
    Copy-Item -LiteralPath $EnvironmentTemplate -Destination $EnvironmentFile
  }
  $lines = [Collections.Generic.List[string]]::new()
  foreach ($line in [IO.File]::ReadAllLines($EnvironmentFile)) { $lines.Add($line) }

  foreach ($name in $Updates.Keys) {
    $value = [string]$Updates[$name]
    if ($value -match "[\r\n]") { throw "Environment values cannot contain line breaks." }
    $replacement = "$name=$value"
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
      if ($lines[$index] -match "^\s*$([Regex]::Escape([string]$name))\s*=") {
        $lines[$index] = $replacement
        $found = $true
      }
    }
    if (-not $found) { $lines.Add($replacement) }
  }
  [IO.File]::WriteAllLines($EnvironmentFile, $lines, $Utf8NoBom)
}

function Convert-ToDockerHostUrl {
  param([Parameter(Mandatory = $true)][string]$Url)

  [Uri]$parsed = $Url
  if ($parsed.Host -notin @("localhost", "127.0.0.1", "::1")) { return $Url }
  $builder = New-Object UriBuilder($parsed)
  $builder.Host = "host.docker.internal"
  return $builder.Uri.AbsoluteUri.TrimEnd("/")
}

function Configure-CollectCapture {
  Write-Step "Collecting the three CollectFolio connection addresses"
  Write-Host "These values are copied into a private local file; no manual editing is needed."
  $existing = Get-EnvironmentValues

  $appCurrent = if ($Reconfigure) { [string]$existing["COLLECTFOLIO_APP_URL"] } elseif ($existing["COLLECTFOLIO_APP_URL"]) { [string]$existing["COLLECTFOLIO_APP_URL"] } else { "" }
  $supabaseCurrent = if ($Reconfigure) { [string]$existing["COLLECTFOLIO_SUPABASE_URL"] } elseif ($existing["COLLECTFOLIO_SUPABASE_URL"]) { [string]$existing["COLLECTFOLIO_SUPABASE_URL"] } else { "" }
  $catalogCurrent = if ($Reconfigure) { [string]$existing["COLLECTFOLIO_CATALOG_URL"] } elseif ($existing["COLLECTFOLIO_CATALOG_URL"]) { [string]$existing["COLLECTFOLIO_CATALOG_URL"] } else { "" }

  $appUrl = if ($appCurrent -and -not $Reconfigure) { $appCurrent } else { Read-RequiredUrl "CollectFolio browser origin (example: https://folio.example.com)" $appCurrent -OriginOnly }
  $supabaseUrl = if ($supabaseCurrent -and -not $Reconfigure) { $supabaseCurrent } else { Read-RequiredUrl "CollectFolio Supabase project URL" $supabaseCurrent -OriginOnly }
  $catalogUrl = if ($catalogCurrent -and -not $Reconfigure) { $catalogCurrent } else { Read-RequiredUrl "CollectFolio catalog API URL" $catalogCurrent }

  $hostnameCurrent = if ($existing["CLOUDFLARE_TUNNEL_HOSTNAME"]) { [string]$existing["CLOUDFLARE_TUNNEL_HOSTNAME"] } else { "" }
  $hostname = if ($hostnameCurrent -and -not $Reconfigure) { $hostnameCurrent } else { Read-RequiredHostname $hostnameCurrent }

  $selectedProvider = Select-RecognitionProvider
  $dockerCatalogUrl = Convert-ToDockerHostUrl -Url $catalogUrl
  $updates = @{
    COLLECTFOLIO_APP_URL = $appUrl
    COLLECTFOLIO_SUPABASE_URL = $supabaseUrl
    COLLECTFOLIO_CATALOG_URL = $dockerCatalogUrl
    CLOUDFLARE_TUNNEL_HOSTNAME = $hostname
  }
  [Uri]$supabaseUri = $supabaseUrl
  $jwksBase = if ($supabaseUri.Host -in @("localhost", "127.0.0.1", "::1")) {
    Convert-ToDockerHostUrl -Url $supabaseUrl
  } else {
    $supabaseUrl
  }
  $updates["COLLECTFOLIO_SUPABASE_JWKS_URL"] = "$jwksBase/auth/v1/.well-known/jwks.json"
  if ($selectedProvider -eq "Groq") {
    $currentKey = [string]$existing["GROQ_API_KEY"]
    if (-not $currentKey -or $Reconfigure) {
      $currentKey = Read-SecretValue "Groq API key (input is hidden)"
    }
    $updates["GROQ_API_KEY"] = $currentKey
  }
  if ($selectedProvider -eq "OllamaCloud") {
    $currentKey = [string]$existing["OLLAMA_API_KEY"]
    if (-not $currentKey -or $Reconfigure) {
      $currentKey = Read-SecretValue "Ollama API key (input is hidden)"
    }
    $updates["OLLAMA_API_KEY"] = $currentKey
  }
  Set-EnvironmentValues -Updates $updates
  Write-Success "Private CollectCapture settings are ready."

  return @{
    Provider = $selectedProvider
    Hostname = $hostname
  }
}

function Ensure-CloudflaredExecutable {
  Write-Step "Preparing the signed Cloudflare Tunnel client"
  [IO.Directory]::CreateDirectory($ToolsDirectory) | Out-Null
  $downloadRequired = -not (Test-Path $CloudflaredPath)
  if (-not $downloadRequired) {
    $hash = (Get-FileHash -LiteralPath $CloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $downloadRequired = ($hash -ne $CloudflaredSha256)
  }
  if ($downloadRequired) {
    $uri = "https://github.com/cloudflare/cloudflared/releases/download/$CloudflaredVersion/cloudflared-windows-amd64.exe"
    Invoke-Download -Uri $uri -Destination $CloudflaredPath
  }
  $actualHash = (Get-FileHash -LiteralPath $CloudflaredPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $CloudflaredSha256) {
    throw "The cloudflared download did not match the pinned SHA-256 digest."
  }
  Assert-AuthenticodePublisher -Path $CloudflaredPath -PublisherPattern "Cloudflare"
  Write-Success "cloudflared $CloudflaredVersion is verified."
}

function Get-CloudflareTunnels {
  $output = & $CloudflaredPath tunnel list --output json 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  try {
    return ,@(($output -join [Environment]::NewLine) | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Ensure-CloudflareLogin {
  $tunnels = Get-CloudflareTunnels
  if ($null -ne $tunnels) { return $tunnels }

  Write-Host "A browser will open for Cloudflare authorization."
  Write-Host "Sign in and select the Cloudflare domain that contains your chosen hostname."
  if (-not (Read-Confirmation "Open Cloudflare authorization now?" $true)) {
    throw "A Cloudflare account and an active Cloudflare-managed domain are required for a stable HTTPS address."
  }
  & $CloudflaredPath tunnel login 2>&1 | Out-Host
  $loginExitCode = $LASTEXITCODE
  if ($loginExitCode -ne 0) {
    throw "Cloudflare browser authorization did not complete."
  }
  $tunnels = Get-CloudflareTunnels
  if ($null -eq $tunnels) {
    throw "Cloudflare authorization completed, but the tunnel list could not be read."
  }
  return $tunnels
}

function Find-TunnelCredential {
  param([Parameter(Mandatory = $true)][string]$TunnelId)

  $fileName = "$TunnelId.json"
  $candidates = @(
    (Join-Path $LocalTunnelDirectory $fileName),
    (Join-Path (Join-Path $env:USERPROFILE ".cloudflared") $fileName)
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return ""
}

function New-CloudflareTunnel {
  param([Parameter(Mandatory = $true)][string]$TunnelName)

  & $CloudflaredPath tunnel create $TunnelName 2>&1 | Out-Host
  $createExitCode = $LASTEXITCODE
  if ($createExitCode -ne 0) {
    throw "Cloudflare could not create the tunnel named $TunnelName."
  }
  $tunnels = Get-CloudflareTunnels
  $created = @($tunnels | Where-Object { $_.name -eq $TunnelName }) | Select-Object -First 1
  if (-not $created -or -not $created.id) {
    throw "The tunnel was created, but its identifier could not be read."
  }
  return [string]$created.id
}

function Get-ExistingLocalTunnelId {
  $credential = Get-ChildItem -LiteralPath $LocalTunnelDirectory -Filter "*.json" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '^[0-9a-fA-F-]{36}$' } |
    Select-Object -First 1
  if ($credential) { return $credential.BaseName }
  return ""
}

function Write-LocalTunnelConfig {
  param(
    [Parameter(Mandatory = $true)][string]$TunnelId,
    [Parameter(Mandatory = $true)][string]$Hostname
  )

  $config = @(
    "tunnel: $TunnelId",
    "credentials-file: /etc/cloudflared/$TunnelId.json",
    "ingress:",
    "  - hostname: $Hostname",
    "    service: http://card-lookups:4100",
    "  - service: http_status:404",
    ""
  ) -join "`n"
  [IO.File]::WriteAllText($LocalTunnelConfig, $config, $Utf8NoBom)
}

function Ensure-CloudflareTunnel {
  param([Parameter(Mandatory = $true)][string]$Hostname)

  Write-Step "Creating the stable public HTTPS tunnel"
  [IO.Directory]::CreateDirectory($LocalTunnelDirectory) | Out-Null
  $localTunnelId = Get-ExistingLocalTunnelId
  if ($localTunnelId -and (Test-Path $LocalTunnelConfig) -and -not $Reconfigure) {
    Write-Success "The existing local Cloudflare Tunnel configuration will be reused."
    return @{
      TunnelId = $localTunnelId
      Hostname = $Hostname
    }
  }

  $tunnels = Ensure-CloudflareLogin
  $computerName = ($env:COMPUTERNAME -replace '[^A-Za-z0-9-]', '-').Trim('-').ToLowerInvariant()
  if (-not $computerName) { $computerName = "red-pc" }
  $baseName = "collectcapture-$computerName"
  if ($baseName.Length -gt 56) { $baseName = $baseName.Substring(0, 56).TrimEnd('-') }

  $tunnelId = $localTunnelId
  $credentialSource = if ($tunnelId) { Find-TunnelCredential -TunnelId $tunnelId } else { "" }
  if (-not $tunnelId) {
    $existing = @($tunnels | Where-Object { $_.name -eq $baseName }) | Select-Object -First 1
    if ($existing) {
      $candidateCredential = Find-TunnelCredential -TunnelId ([string]$existing.id)
      if ($candidateCredential) {
        $tunnelId = [string]$existing.id
        $credentialSource = $candidateCredential
      }
    }
  }
  if (-not $tunnelId) {
    $tunnelName = $baseName
    if (@($tunnels | Where-Object { $_.name -eq $tunnelName }).Count -gt 0) {
      $tunnelName = "$baseName-$([Guid]::NewGuid().ToString('N').Substring(0, 6))"
    }
    $tunnelId = New-CloudflareTunnel -TunnelName $tunnelName
    $credentialSource = Find-TunnelCredential -TunnelId $tunnelId
  }
  if (-not $credentialSource) {
    throw "The tunnel exists, but its local credential JSON could not be found."
  }

  $credentialDestination = Join-Path $LocalTunnelDirectory "$tunnelId.json"
  if (-not ([IO.Path]::GetFullPath($credentialSource)).Equals(
      [IO.Path]::GetFullPath($credentialDestination),
      [StringComparison]::OrdinalIgnoreCase
    )) {
    Copy-Item -LiteralPath $credentialSource -Destination $credentialDestination -Force
  }

  while ($true) {
    Write-Host "Creating the DNS route without overwriting any existing record..."
    & $CloudflaredPath tunnel route dns $tunnelId $Hostname 2>&1 | Out-Host
    $routeExitCode = $LASTEXITCODE
    if ($routeExitCode -eq 0) { break }
    Write-Warning "Cloudflare could not create $Hostname. No existing DNS record was overwritten."
    if (-not (Read-Confirmation "Try a different public hostname?" $true)) {
      throw "Tunnel DNS routing did not complete. Remove the conflicting record or rerun guided setup."
    }
    $Hostname = Read-RequiredHostname
    Set-EnvironmentValues -Updates @{ CLOUDFLARE_TUNNEL_HOSTNAME = $Hostname }
  }
  Write-LocalTunnelConfig -TunnelId $tunnelId -Hostname $Hostname
  Write-Success "Cloudflare will serve https://$Hostname through RED PC."
  return @{
    TunnelId = $tunnelId
    Hostname = $Hostname
  }
}

function Test-NvidiaGpu {
  try {
    $adapter = Get-CimInstance Win32_VideoController |
      Where-Object { $_.Name -match "NVIDIA" } |
      Select-Object -First 1
    $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if (-not $adapter -or -not $nvidiaSmi) { return $false }
    & $nvidiaSmi.Source --query-gpu=name --format=csv,noheader *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Start-CollectCapture {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProvider,
    [Parameter(Mandatory = $true)][bool]$UseNvidia
  )

  Write-Step "Building and starting CollectCapture"
  $launcher = Join-Path $ApplicationDirectory "scripts\red-pc-card-lookups.ps1"
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher, "-Action", "Up", "-Provider", $SelectedProvider, "-Tunnel")
  if ($UseNvidia) { $arguments += "-Nvidia" }
  $powerShellPath = (Get-Process -Id $PID).Path
  & $powerShellPath @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "The CollectCapture Docker stack did not start successfully."
  }
}

function Wait-ForHealthEndpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$Description
  )

  Write-Host "Waiting for $Description..."
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $nextUpdate = [DateTime]::UtcNow
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-RestMethod -Uri $Uri -TimeoutSec 15 -UseBasicParsing
      if ($response.status -eq "ok" -and $response.service -eq "collectcapture-card-lookups") {
        Write-Success "$Description is healthy."
        return
      }
    } catch {
      # Startup, DNS propagation, and certificate provisioning are expected to take time.
      $null = $_
    }
    if ([DateTime]::UtcNow -ge $nextUpdate) {
      Write-Host "  Still waiting for $Uri"
      $nextUpdate = [DateTime]::UtcNow.AddSeconds(30)
    }
    Start-Sleep -Seconds 5
  }
  throw "$Description did not become healthy before the timeout: $Uri"
}

function New-DesktopLauncher {
  $desktop = [Environment]::GetFolderPath("Desktop")
  if (-not $desktop) {
    Write-Warning "Windows did not report a Desktop folder, so no shortcut was created."
    return
  }
  $launcher = Join-Path $ApplicationDirectory "START-COLLECTCAPTURE-HTTPS.cmd"
  $shortcutPath = Join-Path $desktop "CollectCapture HTTPS.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcher
  $shortcut.WorkingDirectory = $ApplicationDirectory
  $shortcut.Description = "Start, stop, and inspect CollectCapture on RED PC"
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
  $shortcut.Save()
  Write-Success "Desktop shortcut created: CollectCapture HTTPS"
}

function Save-BootstrapState {
  param(
    [Parameter(Mandatory = $true)][string]$SelectedProvider,
    [Parameter(Mandatory = $true)][bool]$UseNvidia,
    [Parameter(Mandatory = $true)][string]$Hostname
  )

  $state = @{
    provider = $SelectedProvider
    nvidia = $UseNvidia
    hostname = $Hostname
    installedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json
  [IO.File]::WriteAllText($StateFile, $state, $Utf8NoBom)
}

function Invoke-CollectCaptureBootstrap {
  Clear-Host
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host "       CollectCapture one-command RED PC setup" -ForegroundColor Cyan
  Write-Host "============================================================" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "This setup installs Docker Desktop, downloads CollectCapture, configures"
  Write-Host "a vision provider, creates a stable Cloudflare HTTPS tunnel, and starts it."
  Write-Host "It will not ask you to edit configuration files."
  Write-Host ""
  Write-Host "You will still need:"
  Write-Host "  - the three CollectFolio service addresses;"
  Write-Host "  - a Cloudflare account with a domain already active on Cloudflare DNS;"
  Write-Host "  - browser approval for that domain;"
  Write-Host "  - an API key only if you choose Groq or Ollama Cloud."

  Assert-SupportedWindows
  if ($Provider -and $Provider -notin @("Groq", "OllamaCloud", "OllamaLocal")) {
    throw "Provider must be Groq, OllamaCloud, or OllamaLocal."
  }
  if ($RepositoryRef -notmatch '^[A-Za-z0-9._/-]+$') {
    throw "RepositoryRef contains unsupported characters."
  }
  [IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
  [IO.Directory]::CreateDirectory($ToolsDirectory) | Out-Null
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  Save-PersistedBootstrap

  Ensure-WslReady
  Ensure-DockerDesktop
  Install-CollectCaptureFiles
  $configuration = Configure-CollectCapture
  Ensure-CloudflaredExecutable
  $tunnel = Ensure-CloudflareTunnel -Hostname $configuration.Hostname
  $configuration["Hostname"] = $tunnel.Hostname

  $useNvidia = $false
  if ($configuration.Provider -eq "OllamaLocal") {
    $useNvidia = Test-NvidiaGpu
    if ($useNvidia) {
      Write-Success "An NVIDIA GPU was detected; local Ollama will use Docker GPU acceleration."
    } else {
      Write-Host "No NVIDIA GPU was detected; local Ollama will run on CPU."
    }
  }

  Start-CollectCapture -SelectedProvider $configuration.Provider -UseNvidia $useNvidia
  New-DesktopLauncher
  Save-BootstrapState -SelectedProvider $configuration.Provider -UseNvidia $useNvidia -Hostname $configuration.Hostname
  Wait-ForHealthEndpoint -Uri "http://127.0.0.1:4100/health" -TimeoutSeconds 1800 -Description "the local CollectCapture API"
  Wait-ForHealthEndpoint -Uri "https://$($configuration.Hostname)/health" -TimeoutSeconds 600 -Description "the public HTTPS endpoint"
  Clear-BootstrapResume

  Write-Host ""
  Write-Host "CollectCapture is ready." -ForegroundColor Green
  Write-Host "Public API: https://$($configuration.Hostname)"
  Write-Host "Health:     https://$($configuration.Hostname)/health"
  Write-Host ""
  Write-Host "Use the 'CollectCapture HTTPS' desktop shortcut for future starts, logs, and stops."
}

try {
  $TemporaryDirectory = New-ExactTemporaryDirectory
  Invoke-CollectCaptureBootstrap
} catch {
  Write-Host ""
  Write-Host "CollectCapture setup stopped:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  Write-Host "Fix the item above, then paste the same one-command installer again."
  exit 1
} finally {
  if ($TemporaryDirectory -and (Test-Path $TemporaryDirectory)) {
    Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
