$ErrorActionPreference = "Stop"
$DistDir = "E:\DigitalMUN\Server-Installer\app"
$ZipPath = "E:\DigitalMUN\release\SAFE-MUN-Server.zip"

Write-Host "Building workspace..."
Set-Location -Path "E:\DigitalMUN"
pnpm --filter @mun/server build

Write-Host "Creating distribution folder..."
if (Test-Path $DistDir) {
    Remove-Item -Recurse -Force $DistDir
}
New-Item -ItemType Directory -Path $DistDir | Out-Null

Write-Host "Copying files to $DistDir (this includes node_modules for offline install)..."
# Copy necessary workspace folders
Copy-Item -Path "E:\DigitalMUN\apps" -Destination $DistDir -Recurse -Exclude "desktop"
Copy-Item -Path "E:\DigitalMUN\packages" -Destination $DistDir -Recurse
Copy-Item -Path "E:\DigitalMUN\node_modules" -Destination $DistDir -Recurse
Copy-Item -Path "E:\DigitalMUN\package.json" -Destination $DistDir
Copy-Item -Path "E:\DigitalMUN\pnpm-workspace.yaml" -Destination $DistDir
Copy-Item -Path "E:\DigitalMUN\pnpm-lock.yaml" -Destination $DistDir
Copy-Item -Path "E:\DigitalMUN\.env.example" -Destination "$DistDir\.env"

# Copy the installer script itself
Copy-Item -Path "E:\DigitalMUN\Server-Installer\Install-SAFE-MUN-Server.ps1" -Destination "E:\DigitalMUN\Server-Installer\"

Write-Host "Zipping the distribution..."
if (Test-Path $ZipPath) {
    Remove-Item $ZipPath
}
Compress-Archive -Path "$DistDir\*", "E:\DigitalMUN\Server-Installer\Install-SAFE-MUN-Server.ps1" -DestinationPath $ZipPath

Write-Host "Server bundle created at $ZipPath"
