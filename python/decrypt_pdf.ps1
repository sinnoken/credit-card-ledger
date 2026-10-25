# Batch-decrypt credit card statement PDFs with qpdf
# Usage: put this file in the folder with your PDFs, then run:
#   powershell -ExecutionPolicy Bypass -File .\decrypt_pdf.ps1
# You will be asked for passwords (input is hidden). Press Enter on an empty line to finish.
# Passwords are kept in memory only and never saved to disk.
# Decrypted copies go to the "decrypted" subfolder; originals are untouched.

$qpdf = "C:\Program Files\qpdf 12.4.2\bin\qpdf.exe"
if (-not (Test-Path $qpdf)) {
    # Fallback: find any installed qpdf version
    $found = Get-ChildItem "C:\Program Files*\qpdf*" -Recurse -Filter qpdf.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $qpdf = $found.FullName } else { Write-Host "qpdf.exe not found" -ForegroundColor Red; exit 1 }
}

# ===== Ask for passwords (hidden input) =====
$passwords = @()
while ($true) {
    $sec = Read-Host "Password #$($passwords.Count + 1) (empty to finish)" -AsSecureString
    $plain = [System.Net.NetworkCredential]::new("", $sec).Password
    if ([string]::IsNullOrEmpty($plain)) { break }
    $passwords += $plain
}
if ($passwords.Count -eq 0) { Write-Host "No password entered." -ForegroundColor Yellow; Read-Host "Press Enter to close"; exit 1 }

$folder = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$outDir = Join-Path $folder "decrypted"
New-Item -ItemType Directory -Force $outDir | Out-Null

$okCount = 0; $failList = @()
Get-ChildItem -Path $folder -Filter *.pdf | ForEach-Object {
    $out = Join-Path $outDir $_.Name
    $ok = $false
    foreach ($pw in $passwords) {
        & $qpdf "--password=$pw" --decrypt $_.FullName $out 2>$null
        # 0 = success, 3 = success with warnings
        if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 3) { $ok = $true; break }
    }
    if ($ok) {
        Write-Host "OK   $($_.Name)" -ForegroundColor Green
        $okCount++
    } else {
        Write-Host "FAIL $($_.Name)" -ForegroundColor Red
        if (Test-Path $out) { Remove-Item $out }
        $failList += $_.Name
    }
}
$passwords = $null; $plain = $null

Write-Host ""
Write-Host "Done. Success: $okCount  Failed: $($failList.Count)"
if ($failList.Count -gt 0) { Write-Host "Failed files need another password:" -ForegroundColor Yellow; $failList | ForEach-Object { Write-Host "  $_" } }
Write-Host "Output folder: $outDir"
Read-Host "Press Enter to close"
