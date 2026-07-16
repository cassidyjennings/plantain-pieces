# Start Docker Desktop, self-healing the stale-socket crash that otherwise wedges it.
#
# The failure it fixes
# -------------------
# Docker Desktop's services (Inference manager, secrets engine, ...) listen on AF_UNIX
# sockets, which Windows implements as **reparse points** under %LOCALAPPDATA%. If Docker
# doesn't exit cleanly — a crash, a force-kill, sleep/hibernate mid-operation, a Windows
# update — those socket files are left behind orphaned. On the next launch Docker tries to
# remove the stale file before re-listening, but Windows can't even open it (the reparse tag
# has no owning process), so the remove fails with:
#
#   listening on unix://.../dockerInference: remove .../dockerInference:
#   The file cannot be accessed by the system.
#
# ...and Docker dies during startup. It then recreates the orphan on the next try, so it's a
# self-perpetuating loop that survives restarts — historically only a reboot cleared it.
#
# Why this works without admin
# ----------------------------
# The orphaned files can't be deleted (opening them fails; only an elevated shell with
# backup/restore privileges can force it). But **renaming their parent directory** only
# touches the directory entry, never opens the children — and that is allowed unprivileged.
# Docker then recreates a clean folder and starts normally. The renamed leftovers are inert
# (0-length dead sockets); their file handles clear on reboot, so we opportunistically delete
# old ones on later runs.
#
# Usage: npm run docker:up   (db:start depends on this)

$ErrorActionPreference = 'Stop'

# Folders that hold only runtime sockets — safe to move aside wholesale.
$socketDirs = @(
  (Join-Path $env:LOCALAPPDATA 'Docker\run'),
  (Join-Path $env:LOCALAPPDATA 'docker-secrets-engine')
)

function Test-DockerUp {
  # Redirect inside cmd, not PowerShell: PS 5.1 wraps a native command's stderr in an
  # ErrorRecord, which $ErrorActionPreference='Stop' would turn into a fatal error even though
  # a failing `docker info` is exactly the normal case we're testing for.
  cmd /c "docker info >nul 2>&1"
  return $LASTEXITCODE -eq 0
}

if (Test-DockerUp) {
  Write-Host 'Docker is already running.' -ForegroundColor Green
  exit 0
}

Write-Host 'Docker is not responding - checking for stale sockets...'

# Docker must be fully stopped, or it will hold the folders we're about to move.
foreach ($name in @('Docker Desktop', 'com.docker.backend', 'com.docker.build')) {
  Get-Process -Name $name -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# Sweep away any previously-quarantined folders. These only become deletable once a reboot has
# released the dead sockets' handles, so failures here are expected and harmless.
foreach ($dir in $socketDirs) {
  $parent = Split-Path $dir
  $leaf = Split-Path $dir -Leaf
  Get-ChildItem -LiteralPath $parent -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "$leaf.broken-*" } |
    ForEach-Object {
      try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { }
    }
}

# Quarantine any folder containing an orphaned socket (a reparse point we can't stat).
$moved = @()
foreach ($dir in $socketDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }

  $orphaned = Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.PSIsContainer -and ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }

  if ($orphaned.Count -eq 0) { continue }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $newName = (Split-Path $dir -Leaf) + ".broken-$stamp"
  try {
    Rename-Item -LiteralPath $dir -NewName $newName -ErrorAction Stop
    $moved += $dir
    Write-Host "  cleared stale sockets: $dir" -ForegroundColor Yellow
  } catch {
    Write-Warning "  could not clear $dir : $($_.Exception.Message)"
  }
}

if ($moved.Count -eq 0) { Write-Host '  no stale sockets found.' }

Write-Host 'Starting Docker Desktop...'
Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe' | Out-Null

$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline) {
  if (Test-DockerUp) {
    Write-Host 'Docker is ready.' -ForegroundColor Green
    exit 0
  }
  Start-Sleep -Seconds 3
}

Write-Error 'Docker did not become ready within 3 minutes. Check Docker Desktop for errors.'
exit 1
