#!/usr/bin/env pwsh
param(
  [String]$Version = "latest",
  [Switch]$NoPathUpdate = $false,
  [Switch]$DownloadWithoutCurl = $false
);

$ErrorActionPreference = "Stop"

# Detect real CPU architecture from registry (works accurately even under x64 emulation on ARM64)
$Arch = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment').PROCESSOR_ARCHITECTURE
if (-not ($Arch -eq "AMD64" -or $Arch -eq "ARM64")) {
  Write-Output "Install Failed:"
  Write-Output "ibid for Windows is only available for x86 64-bit and ARM64 Windows.`n"
  exit 1
}

function Publish-Env {
  if (-not ("Win32.NativeMethods" -as [Type])) {
    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
    uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
  }
  $HWND_BROADCAST = [IntPtr] 0xffff
  $WM_SETTINGCHANGE = 0x1a
  $result = [UIntPtr]::Zero
  [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST,
    $WM_SETTINGCHANGE,
    [UIntPtr]::Zero,
    "Environment",
    2,
    5000,
    [ref] $result
  ) | Out-Null
}

function Write-Env {
  param([String]$Key, [String]$Value)
  $RegisterKey = Get-Item -Path 'HKCU:'
  $EnvRegisterKey = $RegisterKey.OpenSubKey('Environment', $true)
  if ($null -eq $Value) {
    $EnvRegisterKey.DeleteValue($Key)
  } else {
    $RegistryValueKind = if ($Value.Contains('%')) {
      [Microsoft.Win32.RegistryValueKind]::ExpandString
    } elseif ($EnvRegisterKey.GetValue($Key)) {
      $EnvRegisterKey.GetValueKind($Key)
    } else {
      [Microsoft.Win32.RegistryValueKind]::String
    }
    $EnvRegisterKey.SetValue($Key, $Value, $RegistryValueKind)
  }
  Publish-Env
}

function Get-Env {
  param([String] $Key)
  $RegisterKey = Get-Item -Path 'HKCU:'
  $EnvRegisterKey = $RegisterKey.OpenSubKey('Environment')
  $EnvRegisterKey.GetValue($Key, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
}

function Install-Ibid {
  param([string]$Version);

  if ($Version -ne "latest" -and $Version -notmatch "^v") {
    $Version = "v$Version"
  }

  $TargetArch = if ($Arch -eq "ARM64") { "aarch64" } else { "x64" }
  $Target = "ibid-windows-$TargetArch"

  $BinDir = if ($env:IBID_INSTALL_DIR) { $env:IBID_INSTALL_DIR } else { "${Home}\.local\bin" }
  $null = New-Item -ItemType Directory -Force -Path $BinDir

  $ExePath = Join-Path $BinDir "ibid.exe"
  $ZipPath = Join-Path $BinDir "$Target.zip"
  $ExtractDir = Join-Path $BinDir $Target

  $GitHub = if ($env:GITHUB) { $env:GITHUB } else { "https://github.com" }
  $BaseURL = "$GitHub/waylon256yhw/ibid/releases"
  $URL = "$BaseURL/$(if ($Version -eq "latest") { "latest/download" } else { "download/$Version" })/$Target.zip"

  Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $ExtractDir -ErrorAction SilentlyContinue

  if (-not $DownloadWithoutCurl) {
    curl.exe "-#SfLo" "$ZipPath" "$URL"
  }
  if ($DownloadWithoutCurl -or ($LASTEXITCODE -ne 0)) {
    try {
      Invoke-RestMethod -Uri $URL -OutFile $ZipPath
    } catch {
      Write-Output "Install Failed - could not download $URL"
      exit 1
    }
  }

  if (!(Test-Path $ZipPath)) {
    Write-Output "Install Failed - downloaded archive '$ZipPath' does not exist."
    exit 1
  }

  try {
    $lastProgressPreference = $global:ProgressPreference
    $global:ProgressPreference = 'SilentlyContinue'
    Expand-Archive "$ZipPath" "$BinDir" -Force
    $global:ProgressPreference = $lastProgressPreference
    $Candidate = Join-Path $ExtractDir "ibid.exe"
    if (!(Test-Path $Candidate)) {
      throw "Archive did not contain '$Candidate'"
    }
    Move-Item $Candidate $ExePath -Force
  } catch {
    Write-Output "Install Failed - could not extract $ZipPath"
    Write-Error $_
    exit 1
  } finally {
    Remove-Item -Recurse -Force $ExtractDir -ErrorAction SilentlyContinue
    Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue
  }

  $VerOut = "$(& $ExePath --version)"
  if ($LASTEXITCODE -ne 0) {
    Write-Output "Install Failed - could not verify $ExePath"
    exit 1
  }

  $C_RESET = [char]27 + "[0m"
  $C_GREEN = [char]27 + "[1;32m"
  Write-Output "${C_GREEN}ibid (${VerOut}) was installed successfully to ${ExePath}${C_RESET}"

  if (-not $NoPathUpdate) {
    $CurrentPath = (Get-Env -Key "Path")
    $Parts = if ($CurrentPath) { $CurrentPath -split ';' } else { @() }
    if ($Parts -notcontains $BinDir) {
      $Parts += $BinDir
      Write-Env -Key 'Path' -Value ($Parts -join ';')
      $env:PATH = "$BinDir;$env:PATH"
      Write-Output "Added '${BinDir}' to your user %PATH%."
    }
  }

  Write-Output "Run 'ibid --help' to get started."
}

Install-Ibid -Version $Version
