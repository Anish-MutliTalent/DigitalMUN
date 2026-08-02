<#
.SYNOPSIS
Installs PostgreSQL, configures the database, and sets up the SAFE MUN 2026 Server.
#>

param(
    [switch]$SkipPostgres = $false
)

# 1. Require Admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Please run this script as an Administrator."
    Pause
    exit
}

$CurrentDir = PSScriptRoot
$AppDir = Join-Path $CurrentDir "app"
$PostgresDir = "C:\Program Files\PostgreSQL\16"
$PsqlPath = Join-Path $PostgresDir "bin\psql.exe"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  SAFE MUN 2026 Server Installer" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 2. Check Node.js
Write-Host "`n[1/4] Checking Node.js..."
try {
    $nodeVersion = node -v
    Write-Host "Node.js is installed ($nodeVersion)." -ForegroundColor Green
} catch {
    Write-Host "Node.js is not installed. Please install Node.js (v20+) from nodejs.org, restart this terminal, and run the script again." -ForegroundColor Red
    Pause
    exit
}

# 3. Check / Install PostgreSQL
Write-Host "`n[2/4] Checking PostgreSQL..."
if ($SkipPostgres -or (Test-Path $PsqlPath)) {
    Write-Host "PostgreSQL is already installed or skipped." -ForegroundColor Green
} else {
    Write-Host "PostgreSQL not found. Downloading PostgreSQL 16 installer... (This may take a few minutes)" -ForegroundColor Yellow
    $PgInstaller = Join-Path $CurrentDir "postgresql-16-installer.exe"
    if (-not (Test-Path $PgInstaller)) {
        Invoke-WebRequest -Uri "https://get.enterprisedb.com/postgresql/postgresql-16.3-2-windows-x64.exe" -OutFile $PgInstaller
    }
    
    Write-Host "Installing PostgreSQL silently (Password: postgres). Please wait..." -ForegroundColor Yellow
    $InstallArgs = "--mode unattended --superpassword postgres --serverport 5432"
    $Proc = Start-Process -FilePath $PgInstaller -ArgumentList $InstallArgs -PassThru -Wait
    
    if ($Proc.ExitCode -eq 0) {
        Write-Host "PostgreSQL installed successfully." -ForegroundColor Green
    } else {
        Write-Host "PostgreSQL installation failed with code $($Proc.ExitCode). Please install it manually." -ForegroundColor Red
        Pause
        exit
    }
}

# 4. Setup Database
Write-Host "`n[3/4] Setting up the database..."
$env:PGPASSWORD = "postgres"
$CheckDbArgs = "-U postgres -h localhost -p 5432 -tAc `"SELECT 1 FROM pg_database WHERE datname='mun'`""
$DbExists = & $PsqlPath -U postgres -h localhost -p 5432 -tAc "SELECT 1 FROM pg_database WHERE datname='mun'"

if ($DbExists -ne "1") {
    Write-Host "Creating 'mun' database..."
    & $PsqlPath -U postgres -h localhost -p 5432 -c "CREATE DATABASE mun;"
} else {
    Write-Host "Database 'mun' already exists." -ForegroundColor Green
}

# 5. Setup Server
Write-Host "`n[4/4] Setting up the Node.js Server..."
Set-Location -Path $AppDir

Write-Host "Running database migrations..."
# Execute migrations using node
node apps/server/dist/db/migrate.js

Write-Host "`n=========================================" -ForegroundColor Cyan
Write-Host " Installation Complete! " -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "To start the server, you can run the 'start-server.bat' file in this folder."

$BatContent = "@echo off`r`ntitle SAFE MUN 2026 Server`r`ncd /d `"%~dp0app`"`r`nnode apps/server/dist/index.js`r`npause"
Set-Content -Path (Join-Path $CurrentDir "start-server.bat") -Value $BatContent

Pause
