# attach-rtlsdr.ps1
# Auto-attach RTL-SDR to WSL at startup

# Wait for system to fully boot
Start-Sleep -Seconds 30

# Install usbipd if not already installed
if (-not (Get-Command usbipd -ErrorAction SilentlyContinue)) {
    Write-Host "Installing usbipd..."
    winget install usbipd
}

# Wait for usbipd to be ready
Start-Sleep -Seconds 10

# List USB devices and find RTL-SDR
$devices = usbipd list
Write-Host "Available USB devices:"
Write-Host $devices

# Look for RTL-SDR device (common identifiers)
$rtlsdrBusId = $null
foreach ($line in $devices -split "`n") {
    if ($line -match "(\d+-\d+).*(?:RTL28|RTL-SDR|DVB-T|Bulk-in)") {
        $rtlsdrBusId = $matches[1]
        Write-Host "Found RTL-SDR at bus ID: $rtlsdrBusId"
        break
    }
}

if ($rtlsdrBusId) {
    # Bind the device
    Write-Host "Binding RTL-SDR..."
    usbipd bind --busid $rtlsdrBusId
    
    # Wait a moment
    Start-Sleep -Seconds 5
    
    # Attach to WSL
    Write-Host "Attaching RTL-SDR to WSL..."
    usbipd attach --busid $rtlsdrBusId --wsl Ubuntu
    
    Write-Host "RTL-SDR attached successfully!"
} else {
    Write-Host "RTL-SDR device not found. Please check connection."
}