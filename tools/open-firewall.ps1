# =============================================================
# Allow inbound connections to the game server (Windows Firewall)
#
# Why this is needed: Windows Firewall does NOT block host->host traffic,
# so "http://127.0.0.1:3000 works on the PC" does NOT mean the phone can
# reach it. The phone connects from OUTSIDE and gets dropped by the
# inbound rules -- which shows up as "cannot connect" forever.
#
# Usage (must run PowerShell as Administrator):
#   powershell -ExecutionPolicy Bypass -File tools\open-firewall.ps1
#   powershell -ExecutionPolicy Bypass -File tools\open-firewall.ps1 -Port 3000
#
# NOTE: this file is intentionally ASCII-only.
# Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII text here would
# be mojibake and break string literals.
# =============================================================
param(
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$RuleName = 'Gremlins Inc Server (TCP ' + $Port + ')'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host 'ERROR: Administrator privileges required.' -ForegroundColor Red
  Write-Host ''
  Write-Host 'Open PowerShell as Administrator, then run:' -ForegroundColor Yellow
  Write-Host '  powershell -ExecutionPolicy Bypass -File tools\open-firewall.ps1' -ForegroundColor Cyan
  exit 1
}

$existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existing) {
  $existing | Set-NetFirewallRule -Enabled True -Action Allow | Out-Null
  Write-Host ('OK: rule already exists and is enabled -> ' + $RuleName) -ForegroundColor Green
} else {
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain -Description 'Gremlins Inc LAN server' | Out-Null
  Write-Host ('OK: added inbound rule -> ' + $RuleName) -ForegroundColor Green
  Write-Host 'Allowed for Private/Domain profiles only. If the phone network is marked Public, switch it to Private.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'Server address to enter on the phone:' -ForegroundColor Cyan
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
if ($ips) {
  foreach ($i in $ips) {
    Write-Host ('  http://' + $i.IPAddress + ':' + $Port) -ForegroundColor White
  }
} else {
  Write-Host '  No LAN IPv4 found. Make sure WiFi or Ethernet is connected.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Checklist: 1) server started  2) phone on same WiFi  3) this rule allowed' -ForegroundColor DarkGray
