# build-venio-preview.ps1
# Builds venio's Flutter Web *preview* bundle for PageMapper "Live" mode (Model A).
#
# Output: <VenioApp>\build\web  — a static site you deploy once and point
# PageMapper at via --app-url. People who clone PageMapper then need NO Flutter.
#
# IMPORTANT: uses the DIRECT fvm binary, not the `fvm` shim. The shim resolves to
# the global Flutter and fails with "Can't load Kernel binary (expected 125, found 130)".
#
# Usage:
#   pwsh scripts/build-venio-preview.ps1
#   pwsh scripts/build-venio-preview.ps1 -VenioApp "D:\path\to\apps\venio_app"

param(
  [string]$VenioApp = "C:\Users\kin\Documents\GitHub\venio-mobile-app\apps\venio_app",
  [string]$Flutter  = "C:\Users\kin\fvm\versions\3.44.1\bin\flutter.bat"
)

if (-not (Test-Path $Flutter))  { Write-Error "Flutter not found: $Flutter"; exit 1 }
if (-not (Test-Path $VenioApp)) { Write-Error "venio_app not found: $VenioApp"; exit 1 }
if (-not (Test-Path "$VenioApp\lib\main_web_preview.dart")) {
  Write-Error "main_web_preview.dart missing — check out the web-preview-uat branch first."; exit 1
}

Write-Host "Building venio Flutter Web preview (this takes ~1-2 min)..." -ForegroundColor Cyan
Set-Location $VenioApp
& $Flutter build web -t lib/main_web_preview.dart --no-wasm-dry-run --no-tree-shake-icons
if ($LASTEXITCODE -ne 0) { Write-Error "Flutter build failed (exit $LASTEXITCODE)"; exit $LASTEXITCODE }

$out = Join-Path $VenioApp "build\web"

# Add the Basic-Auth gate (Vercel Edge Middleware). Flutter wipes build/web each
# build, so re-copy it every time. Active only when PREVIEW_PASS is set in Vercel.
$mw = Join-Path $PSScriptRoot "preview-middleware.js"
if (Test-Path $mw) {
  Copy-Item $mw (Join-Path $out "middleware.js") -Force
  Write-Host "Added auth gate: middleware.js (set PREVIEW_PASS in Vercel to enable)" -ForegroundColor Cyan
} else {
  Write-Warning "preview-middleware.js not found — the deploy will be PUBLIC (no auth)."
}

Write-Host ""
Write-Host "Built: $out" -ForegroundColor Green
Write-Host "Deploy it (needs ``vercel login`` once):" -ForegroundColor Yellow
Write-Host "    vercel deploy `"$out`" --prod"
Write-Host "First time, set the shared password (then redeploy):" -ForegroundColor Yellow
Write-Host "    vercel env add PREVIEW_PASS production"
Write-Host "Then run PageMapper with:  node dist/cli.js <venio> --app-url https://<your-vercel-url>"
