# Minimal static file server on http://localhost:<port>/ using only built-in .NET (no installs).
# Serving from localhost (instead of file://) keeps screen/system-audio capture permissions reliable.
param([int]$Port = 8765, [switch]$NoBrowser, [switch]$DryRun)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$url = "http://localhost:$Port/"

# Always open in an Edge app window with the discrete GPU flag. Falling back to
# Start-Process $url would hand the page to the default browser in a normal tab, which
# on a dual-GPU PC quietly lands on the Intel chip and halves the frame rate.
function Open-App {
  param([string]$Address, [switch]$DryRun)
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $edge) {
    Write-Host "Edge not found - opening your default browser. For full GPU performance, install Edge or set this browser to 'High performance' in Windows Graphics settings."
    if (-not $DryRun) { Start-Process $Address }
    return 'default'
  }
  # Own profile = own browser process, so the flags below apply even if Edge is already open.
  $profileDir = Join-Path $env:LOCALAPPDATA 'FractalDrift\edge-profile'
  $argLine = "--app=$Address --start-maximized --user-data-dir=`"$profileDir`" --force_high_performance_gpu --no-first-run"
  if ($DryRun) { Write-Host "$edge $argLine"; return 'edge' }
  Start-Process $edge $argLine
  return 'edge'
}

if ($DryRun) { Open-App -Address $url -DryRun | Out-Null; exit }

try { $listener.Start() } catch {
  Write-Host "Port $Port is busy - Fractal Drift is already running. Opening that one."
  if (-not $NoBrowser) { Open-App -Address $url | Out-Null }
  exit
}
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.json' = 'application/json'; '.ico' = 'image/x-icon' }
Write-Host "Fractal Drift running at $url  (close this window to stop)"

if (-not $NoBrowser) { Open-App -Address $url | Out-Null }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($root) -or -not (Test-Path $path -PathType Leaf)) {
      $res.StatusCode = 404
    } else {
      $ext = [IO.Path]::GetExtension($path).ToLower()
      $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-store')
      $bytes = [IO.File]::ReadAllBytes($path)
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch { $res.StatusCode = 500 }
  $res.Close()
}
