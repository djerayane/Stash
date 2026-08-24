param([ValidateSet("Apply", "Remove")][string]$Action, [string]$State = "$env:RUNNER_TEMP\stash-disabled-container-tools.txt")
$ErrorActionPreference = "Stop"
if ($Action -eq "Apply") {
  $paths = @(Get-Command docker.exe,podman.exe -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -Unique)
  Set-Content -LiteralPath $State -Value $paths
  foreach ($path in $paths) { Move-Item -LiteralPath $path -Destination "$path.stash-disabled" }
  foreach ($name in "docker.exe","podman.exe") { if (Get-Command $name -ErrorAction SilentlyContinue) { throw "$name remains executable after isolation" } }
} else {
  if (Test-Path -LiteralPath $State) { foreach ($path in Get-Content -LiteralPath $State) { if ($path -and (Test-Path -LiteralPath "$path.stash-disabled")) { Move-Item -LiteralPath "$path.stash-disabled" -Destination $path } } Remove-Item -LiteralPath $State }
}
