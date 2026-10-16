<#
.SYNOPSIS
    Adds (or with -Remove, removes) the "Google Web Results Only" extension in
    Chrome's ExtensionInstallForcelist policy on this PC.

.DESCRIPTION
    Appends one value under
        HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
    using the next free number. Existing values are never overwritten or
    renumbered. If an entry for the same extension ID already exists, nothing
    is changed. -Remove deletes only the values for this extension ID.

    Run from an elevated (Administrator) PowerShell:
        .\Set-ChromeForceInstall.ps1
        .\Set-ChromeForceInstall.ps1 -Remove

    Then open chrome://policy in Chrome and click "Reload policies".

.NOTES
    IMPORTANT: If a Group Policy Object also manages ExtensionInstallForcelist
    on this PC, GPO will overwrite the changes made by this script at the next
    policy refresh (gpupdate). In that case do not use this script; add the
    entry below to the GPO instead (Computer Configuration > Policies >
    Administrative Templates > Google > Google Chrome > Extensions >
    "Configure the list of force-installed apps and extensions").
#>
[CmdletBinding()]
param(
    [switch]$Remove
)

# ---- Settings: copy these from the GitHub Actions run summary ---------------
$ExtensionId = 'REPLACE_WITH_EXTENSION_ID'
$UpdateUrl   = 'https://onemako.github.io/block-google-ai-search/updates.xml'
# -----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$KeyPath = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
$Entry   = "$ExtensionId;$UpdateUrl"

if ($ExtensionId -notmatch '^[a-p]{32}$') {
    throw "ExtensionId '$ExtensionId' is not a valid Chrome extension ID (32 letters a-p). Edit the settings at the top of this script."
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must be run from an elevated (Run as Administrator) PowerShell.'
}

# Returns the numbered values of the forcelist key as objects with Name and Data.
function Get-ForcelistValues {
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

$values = @(Get-ForcelistValues)
$ours   = @($values | Where-Object { Test-IsOurEntry $_.Data })

if ($Remove) {
    if ($ours.Count -eq 0) {
        Write-Host "No ExtensionInstallForcelist entry for $ExtensionId found. Nothing changed."
        return
    }
    foreach ($v in $ours) {
        Remove-ItemProperty -LiteralPath $KeyPath -Name $v.Name
        Write-Host "Removed value '$($v.Name)' = '$($v.Data)' from $KeyPath"
    }
    Write-Host 'Other entries were left untouched. Reload policies in chrome://policy.'
    return
}

if ($ours.Count -gt 0) {
    foreach ($v in $ours) {
        Write-Host "Already present: value '$($v.Name)' = '$($v.Data)'. Nothing changed."
        if ($v.Data -ne $Entry) {
            Write-Warning "The existing entry differs from '$Entry'. Run with -Remove first if you want to replace it."
        }
    }
    return
}

if (-not (Test-Path -LiteralPath $KeyPath)) {
    New-Item -Path $KeyPath -Force | Out-Null
    Write-Host "Created key $KeyPath"
}

# Next number = highest existing numeric value name + 1 (gaps are left alone).
$max = 0
foreach ($v in $values) {
    $n = 0
    if ([int]::TryParse($v.Name, [ref]$n) -and $n -gt $max) { $max = $n }
}
$newName = [string]($max + 1)

New-ItemProperty -LiteralPath $KeyPath -Name $newName -PropertyType String -Value $Entry | Out-Null
Write-Host "Added value '$newName' = '$Entry' to $KeyPath"
Write-Host 'Reload policies in chrome://policy (or restart Chrome) to install the extension.'
