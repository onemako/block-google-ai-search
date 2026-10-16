<#
.SYNOPSIS
    Adds (or with -Remove, removes) the "Google Web Results Only" extension in
    the ExtensionInstallForcelist policy of Google Chrome and Microsoft Edge on
    this PC.

.DESCRIPTION
    For each browser in $Browsers, appends one value under its
    ExtensionInstallForcelist policy key using the next free number:
        Chrome: HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
        Edge:   HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist
    Existing values are never overwritten or renumbered. If an entry for the
    same extension ID already exists, nothing is changed for that browser.
    -Remove deletes only the values for this extension ID.

    Run from an elevated (Administrator) PowerShell:
        powershell -ExecutionPolicy Bypass -File .\Set-ExtensionForceInstall.ps1
        powershell -ExecutionPolicy Bypass -File .\Set-ExtensionForceInstall.ps1 -Remove

    Then open chrome://policy or edge://policy and click "Reload policies".
    Both browsers only accept this self-hosted extension on PCs that are
    domain-joined or MDM-enrolled.

.NOTES
    IMPORTANT: If a Group Policy Object also manages ExtensionInstallForcelist
    for a browser on this PC, GPO will overwrite the changes made by this
    script at the next policy refresh (gpupdate). In that case do not use this
    script for that browser; add the entry to the GPO instead:
      Chrome: Computer Configuration > Policies > Administrative Templates >
              Google > Google Chrome > Extensions >
              "Configure the list of force-installed apps and extensions"
      Edge:   Computer Configuration > Policies > Administrative Templates >
              Microsoft Edge > Extensions >
              "Control which extensions are installed silently"
#>
[CmdletBinding()]
param(
    [switch]$Remove
)

# ---- Settings (ID is fixed by the EXTENSION_PEM signing key) ----------------
$ExtensionId = 'enkieoehgkejdljiejbjmenfloafdfgg'
$UpdateUrl   = 'https://onemako.github.io/block-google-ai-search/updates.xml'
$Browsers    = @('Chrome', 'Edge')   # remove one to manage only the other
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$PolicyKeys = @{
    Chrome = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
    Edge   = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'
}
$Entry = "$ExtensionId;$UpdateUrl"

if ($ExtensionId -notmatch '^[a-p]{32}$') {
    throw "ExtensionId '$ExtensionId' is not a valid extension ID (32 letters a-p). Edit the settings at the top of this script."
}
foreach ($b in $Browsers) {
    if (-not $PolicyKeys.ContainsKey($b)) { throw "Unknown browser '$b' in `$Browsers. Use 'Chrome' and/or 'Edge'." }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must be run from an elevated (Run as Administrator) PowerShell.'
}

# Returns the values of a forcelist key as objects with Name and Data.
function Get-ForcelistValues([string]$KeyPath) {
    if (-not (Test-Path -LiteralPath $KeyPath)) { return @() }
    $key = Get-Item -LiteralPath $KeyPath
    foreach ($name in $key.GetValueNames()) {
        [pscustomobject]@{ Name = $name; Data = [string]$key.GetValue($name) }
    }
}

# An entry belongs to this extension if it is "<id>" or starts with "<id>;".
function Test-IsOurEntry([string]$Data) {
    $id = ($Data -split ';', 2)[0].Trim()
    return $id -eq $ExtensionId
}

function Remove-OurEntry([string]$Browser, [string]$KeyPath) {
    $ours = @(Get-ForcelistValues $KeyPath | Where-Object { Test-IsOurEntry $_.Data })
    if ($ours.Count -eq 0) {
        Write-Host "[$Browser] No entry for $ExtensionId found. Nothing changed."
        return
    }
    foreach ($v in $ours) {
        Remove-ItemProperty -LiteralPath $KeyPath -Name $v.Name
        Write-Host "[$Browser] Removed value '$($v.Name)' = '$($v.Data)' from $KeyPath"
    }
    Write-Host "[$Browser] Other entries were left untouched."
}

function Add-OurEntry([string]$Browser, [string]$KeyPath) {
    $values = @(Get-ForcelistValues $KeyPath)
    $ours   = @($values | Where-Object { Test-IsOurEntry $_.Data })
    if ($ours.Count -gt 0) {
        foreach ($v in $ours) {
            Write-Host "[$Browser] Already present: value '$($v.Name)' = '$($v.Data)'. Nothing changed."
            if ($v.Data -ne $Entry) {
                Write-Warning "[$Browser] The existing entry differs from '$Entry'. Run with -Remove first if you want to replace it."
            }
        }
        return
    }

    if (-not (Test-Path -LiteralPath $KeyPath)) {
        New-Item -Path $KeyPath -Force | Out-Null
        Write-Host "[$Browser] Created key $KeyPath"
    }

    # Next number = highest existing numeric value name + 1 (gaps are left alone).
    $max = 0
    foreach ($v in $values) {
        $n = 0
        if ([int]::TryParse($v.Name, [ref]$n) -and $n -gt $max) { $max = $n }
    }
    $newName = [string]($max + 1)

    New-ItemProperty -LiteralPath $KeyPath -Name $newName -PropertyType String -Value $Entry | Out-Null
    Write-Host "[$Browser] Added value '$newName' = '$Entry' to $KeyPath"
}

foreach ($b in $Browsers) {
    if ($Remove) { Remove-OurEntry $b $PolicyKeys[$b] } else { Add-OurEntry $b $PolicyKeys[$b] }
}
Write-Host 'Reload policies in chrome://policy and edge://policy (or restart the browsers).'
