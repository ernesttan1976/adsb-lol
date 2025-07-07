# ADSB.lol Feeder Setup Guide for Windows WSL + Docker

This guide covers setting up an ADSB.lol feeder on Windows using WSL (Windows Subsystem for Linux) with Docker.

## Prerequisites
- Windows 10/11 with WSL2 enabled
- Docker Desktop for Windows installed and running
- RTL-SDR dongle or compatible ADS-B receiver
- Internet connection
- Good antenna placement with clear sky view
- USB passthrough capability to WSL (Windows 11 or Windows 10 with usbipd)

## Step 1: WSL2 and Docker Setup

### Verify WSL2 Installation
```powershell
# Run in PowerShell as Administrator
wsl --list --verbose
```

If WSL2 isn't installed:
```powershell
# Enable WSL feature
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart

# Enable Virtual Machine Platform
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

# Restart Windows, then set WSL2 as default
wsl --set-default-version 2

# Install Ubuntu (recommended)
wsl --install Ubuntu
```

### Install Docker Desktop
1. Download and install Docker Desktop for Windows
2. Enable WSL2 integration in Docker Desktop settings
3. Ensure Docker is running and accessible from WSL

### Verify Docker in WSL
```bash
# In WSL terminal
docker --version
docker-compose --version
```

## Step 2: USB Device Setup for RTL-SDR

### Option A: Windows 11 or Windows 10 with usbipd (Recommended)

**Install usbipd on Windows:**
```powershell
# Run in PowerShell as Administrator
winget install usbipd
```

**Connect RTL-SDR to WSL:**
```powershell
# List USB devices (run in PowerShell as Administrator)
usbipd list

# Find your RTL-SDR device (usually shows as "Bulk-in, Interface")
# Note the BUS ID (e.g., 2-1)

# Bind the device
usbipd bind --busid 2-1

# Attach to WSL (replace "Ubuntu" with your WSL distro name)
usbipd attach --busid 2-1 --wsl Ubuntu
```

**Verify in WSL:**
```bash
# In WSL terminal
sudo apt install usbutils rtl-sdr librtlsdr-dev
lsusb
# Should show your RTL-SDR device
```

### Option B: Docker Desktop Device Passthrough

If usbipd doesn't work, use Docker Desktop's device passthrough:

**Install RTL-SDR drivers in WSL:**
```bash
# In WSL terminal
sudo apt update
sudo apt install rtl-sdr librtlsdr-dev
```

## Step 3: ADSB.lol Feeder Installation

### Method 1: ADSB.lol Docker Toolkit (Recommended for WSL)

**Create project directory:**
```bash
# In WSL terminal
mkdir -p ~/adsb-feeder
cd ~/adsb-feeder
```

**Download and setup:**
```bash
# Download the installation script
curl -Ls https://raw.githubusercontent.com/adsblol/feed/main/bin/adsblol-init > adsblol-init.sh

# Review the script (recommended for security)
cat adsblol-init.sh

# Make executable and run
chmod +x adsblol-init.sh
sudo ./adsblol-init.sh

# Navigate to installation directory
cd /opt/adsblol/
sudo cp .env.example .env
```

**Configuration:**
```bash
# Set essential environment variables (replace with your coordinates)
sudo bash -c 'cat > /opt/adsblol/.env << EOF
# Location coordinates (required for MLAT)
FEEDER_LAT=40.7128
FEEDER_LONG=-74.0060
FEEDER_ALT_M=30

# Timezone
FEEDER_TZ=America/New_York

# SDR Configuration
ADSB_DONGLE_SERIAL=1090

# Site identification
MLAT_SITE_NAME="My WSL ADSB Station"

# Privacy settings (optional - hides you from MLAT map)
# ADSBLOL_MLAT_CONFIG=--privacy
EOF'
```

**Start the feeder:**
```bash
cd /opt/adsblol/
sudo docker-compose up -d
```

### Method 2: Custom Docker Compose (More Control)

**Create project directory:**
```bash
mkdir -p ~/adsb-feeder
cd ~/adsb-feeder
```

**Create docker-compose.yml:**
```bash
cat > docker-compose.yml << 'EOF'
version: '3.8'

services:
  ultrafeeder:
    image: ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder
    container_name: adsb-ultrafeeder
    hostname: adsb-ultrafeeder
    restart: unless-stopped
    
    # USB device access for RTL-SDR
    privileged: true
    devices:
      - /dev/bus/usb:/dev/bus/usb
    
    ports:
      - "8080:80"          # Web interface
      - "30005:30005"      # Beast output
      - "30003:30003"      # SBS output
    
    environment:
      # Logging
      - LOGLEVEL=error
      - TZ=America/New_York
      
      # SDR Configuration
      - READSB_DEVICE_TYPE=rtlsdr
      - READSB_RTLSDR_DEVICE=1090
      - READSB_GAIN=auto
      - READSB_RTLSDR_PPM=0
      
      # Location (CHANGE THESE TO YOUR COORDINATES)
      - READSB_LAT=40.7128
      - READSB_LON=-74.0060
      - READSB_ALT=30m
      
      # ADSB.lol Feed Configuration
      - ULTRAFEEDER_CONFIG=
          adsb,in.adsb.lol,30004,beast_reduce_plus_out;
          mlat,in.adsb.lol,31090,--lat,40.7128,--lon,-74.0060,--alt,30
      
      # Optional: Additional aggregators
      # - ULTRAFEEDER_CONFIG=
      #     adsb,feed.adsbexchange.com,30004,beast_reduce_plus_out;
      #     adsb,feed.theairtraffic.com,30004,beast_reduce_plus_out;
      #     mlat,feed.adsbexchange.com,31090,--lat,40.7128,--lon,-74.0060,--alt,30;
      #     mlat,feed.theairtraffic.com,31090,--lat,40.7128,--lon,-74.0060,--alt,30
      
      # Web interface settings
      - READSB_NET_API_PORT=30152
      - TAR1090_DEFAULTCENTERLAT=40.7128
      - TAR1090_DEFAULTCENTERLON=-74.0060
      - TAR1090_DEFAULTZOOMLVL=8
      
    volumes:
      - adsb_data:/opt/adsb
      - adsb_history:/var/globe_history
      - adsb_collectd:/var/lib/collectd
    
    tmpfs:
      - /tmp:exec,size=64M
      - /var/log:size=32M

volumes:
  adsb_data:
  adsb_history:
  adsb_collectd:
EOF
```

**Important: Update coordinates in the docker-compose.yml file**
```bash
# Edit the file to replace coordinates with your actual location
nano docker-compose.yml

# Replace these values:
# READSB_LAT=40.7128      <- Your latitude
# READSB_LON=-74.0060     <- Your longitude  
# READSB_ALT=30m          <- Your altitude in meters
# TAR1090_DEFAULTCENTERLAT=40.7128
# TAR1090_DEFAULTCENTERLON=-74.0060
# And in the MLAT configuration: --lat,40.7128,--lon,-74.0060,--alt,30
```

**Start the feeder:**
```bash
docker-compose up -d
```

## Step 4: Verification and Monitoring

### Check Container Status
```bash
# View running containers
docker ps

# Check logs
docker logs adsb-ultrafeeder

# Follow logs in real-time
docker logs -f adsb-ultrafeeder
```

### Access Web Interface
Open your browser and navigate to:
- **http://localhost:8080** - Main tracking interface
- **http://localhost:8080/graphs1090** - Performance graphs

### Verify RTL-SDR Detection
```bash
# Check if RTL-SDR is detected
docker exec adsb-ultrafeeder rtl_test -t
```

### Monitor Data Flow
```bash
# Check if data is being received
docker exec adsb-ultrafeeder readsb --help
docker logs adsb-ultrafeeder 2>&1 | grep -i "aircraft\|message\|mlat"
```

## Step 5: Adding Multiple Aggregators (Optional)

To feed additional aggregators while maintaining ADSB.lol as primary:

**Edit docker-compose.yml:**
```bash
nano docker-compose.yml
```

**Uncomment and modify the additional ULTRAFEEDER_CONFIG section:**
```yaml
      # Uncomment and modify this section:
      - ULTRAFEEDER_CONFIG=
          adsb,in.adsb.lol,30004,beast_reduce_plus_out;
          adsb,feed.adsbexchange.com,30004,beast_reduce_plus_out;
          adsb,feed.theairtraffic.com,30004,beast_reduce_plus_out;
          mlat,in.adsb.lol,31090,--lat,YOUR_LAT,--lon,YOUR_LON,--alt,YOUR_ALT;
          mlat,feed.adsbexchange.com,31090,--lat,YOUR_LAT,--lon,YOUR_LON,--alt,YOUR_ALT;
          mlat,feed.theairtraffic.com,31090,--lat,YOUR_LAT,--lon,YOUR_LON,--alt,YOUR_ALT
```

**Restart the service:**
```bash
docker-compose restart
```

## WSL-Specific Troubleshooting

### RTL-SDR Not Detected
```bash
# In WSL, check USB devices
lsusb

# If device not visible, reconnect via usbipd (Windows PowerShell as Admin):
# usbipd detach --busid 2-1
# usbipd attach --wsl --busid 2-1 --distribution Ubuntu

# Check Docker device access
docker exec adsb-ultrafeeder lsusb
```

### Permission Issues
```bash
# Fix Docker permissions
sudo usermod -aG docker $USER
newgrp docker

# Fix USB permissions
sudo usermod -aG dialout $USER
```

### WSL Memory Issues
```bash
# Create/edit .wslconfig in Windows user directory (C:\Users\YourName\.wslconfig)
# Add these settings to limit memory usage:

[wsl2]
memory=4GB
processors=2
swap=2GB
```

### Container Won't Start
```bash
# Check Docker daemon
sudo service docker start

# Restart Docker Desktop from Windows

# Check for port conflicts
netstat -tulpn | grep :8080
```

### Gain Optimization
```bash
# Monitor reception quality
docker logs adsb-ultrafeeder 2>&1 | grep -i "gain\|autogain"

# Manual gain setting (if auto doesn't work well)
# Edit docker-compose.yml and change:
# - READSB_GAIN=auto
# to:
# - READSB_GAIN=42.1   # or other value from: 0.0 0.9 1.4 2.7 3.7 7.7 8.7 12.5 14.4 15.7 16.6 19.7 20.7 22.9 25.4 28.0 29.7 32.8 33.8 36.4 37.2 38.6 40.2 42.1 43.4 43.9 44.5 48.0 49.6 58
```

## Monitoring Performance

### Key Metrics to Watch
- **Messages/sec**: Should be > 100 in populated areas
- **Aircraft count**: Varies by location and time
- **Range**: Depends on antenna height and environment
- **CPU usage**: Should be reasonable (< 50% typically)

### Performance Commands
```bash
# Container resource usage
docker stats adsb-ultrafeeder

# Detailed logs with timestamps
docker logs adsb-ultrafeeder --timestamps

# Check MLAT synchronization
docker logs adsb-ultrafeeder 2>&1 | grep -i mlat
```

## Maintenance

### Regular Updates
```bash
# Update container images
docker-compose pull
docker-compose up -d

# Clean up old images
docker image prune
```

### Backup Configuration
```bash
# Backup your docker-compose.yml and any custom configs
cp docker-compose.yml ~/adsb-backup-$(date +%Y%m%d).yml
```

### Restart Services
```bash
# Restart just the container
docker-compose restart

# Full recreation
docker-compose down && docker-compose up -d
```

This setup will have your WSL-based feeder contributing ADS-B and MLAT data to ADSB.lol, with the option to feed multiple aggregators simultaneously.