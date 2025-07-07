# ADSB.lol Comprehensive Implementation Guide

This guide covers two implementations for ADSB.lol:
1. **Setting up a feeder for ADSB.lol** (contributing ADS-B data)
2. **Setting up a beast mode downloader** (consuming aggregated data for research)

## Part 1: ADSB.lol Feeder Setup (Docker Method)

### Prerequisites
- Raspberry Pi or Linux system (Debian-based recommended)
- RTL-SDR dongle or compatible ADS-B receiver
- Docker installed
- Internet connection
- Good antenna placement with clear sky view

### Method 1: ADSB.lol Docker Toolkit (Recommended)

**Step 1: Quick Installation**
```bash
# Run as root on fresh Raspberry Pi OS Lite or similar
curl -Ls https://raw.githubusercontent.com/adsblol/feed/main/bin/adsblol-init | bash
cd /opt/adsblol/
cp .env.example .env
```

**Step 2: Configuration**
```bash
# Set essential environment variables
# Altitude in meters
adsblol-env set FEEDER_ALT_M 542

# Latitude (decimal degrees)
adsblol-env set FEEDER_LAT 98.76543

# Longitude (decimal degrees) 
adsblol-env set FEEDER_LONG 12.34567

# Timezone (see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
adsblol-env set FEEDER_TZ America/New_York

# SDR Serial Number
adsblol-env set ADSB_DONGLE_SERIAL 1090

# Site name (shows up on the MLAT map!)
adsblol-env set MLAT_SITE_NAME "My epic site"

# Appear on mlat.adsb.lol map
adsblol-env unset ADSBLOL_MLAT_CONFIG
```

**Step 3: Start the Feeder**
```bash
cd /opt/adsblol/
docker-compose up -d
```

**Step 4: Add Additional Aggregators (Optional)**
```bash
# To feed multiple aggregators (theairtraffic.com and adsbexchange.com)
adsblol-env set ADSBLOL_ADDITIONAL_NET_CONNECTOR "feed.adsbexchange.com,30004,beast_reduce_out;feed.theairtraffic.com,30004,beast_reduce_out"

adsblol-env set ADSBLOL_ADDITIONAL_MLAT_CONFIG "feed.adsbexchange.com,31090,39001,--privacy;feed.theairtraffic.com,31090,39002,--privacy"

adsblol-env set MLATHUB_NET_CONNECTOR "adsblol,39000,beast_in;adsblol,39001,beast_in;adsblol,39002,beast_in"

# Restart after configuration changes
docker-compose restart
```

### Method 2: SDR-Enthusiasts Ultrafeeder (Alternative)

**Step 1: Create docker-compose.yml**
```yaml
version: '3.8'

services:
  ultrafeeder:
    image: ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder
    container_name: ultrafeeder
    hostname: ultrafeeder
    restart: unless-stopped
    device_cgroup_rules:
      - 'c 189:* rwm'
    ports:
      - 8080:80
    environment:
      - LOGLEVEL=error
      - TZ=America/New_York
      
      # SDR Configuration
      - READSB_DEVICE_TYPE=rtlsdr
      - READSB_RTLSDR_DEVICE=1090
      - READSB_GAIN=auto
      
      # Location
      - READSB_LAT=98.76543
      - READSB_LON=12.34567
      - READSB_ALT=542m
      
      # Feed Configuration
      - ULTRAFEEDER_CONFIG=
          adsb,in.adsb.lol,30004,beast_reduce_plus_out;
          mlat,in.adsb.lol,31090
      
      # Additional feeds (optional)
      - ULTRAFEEDER_CONFIG=
          adsb,feed.adsbexchange.com,30004,beast_reduce_plus_out;
          adsb,feed.theairtraffic.com,30004,beast_reduce_plus_out;
          mlat,feed.adsbexchange.com,31090;
          mlat,feed.theairtraffic.com,31090
          
    volumes:
      - /var/globe_history:/var/globe_history
      - /var/lib/collectd:/var/lib/collectd
      - /proc/diskstats:/proc/diskstats:ro
    devices:
      - /dev/bus/usb:/dev/bus/usb
```

**Step 2: Start Ultrafeeder**
```bash
docker-compose up -d
```

## Part 2: Beast Mode Data Downloader (Research Consumer)

### Option 1: Using Wiedehopf's readsb (Direct Beast Connection)

This method connects directly to ADSB.lol's beast output for real-time data consumption.

**Step 1: Install Dependencies**
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install --no-install-recommends --no-install-suggests -y \
    git build-essential debhelper libusb-1.0-0-dev \
    librtlsdr-dev librtlsdr0 pkg-config fakeroot \
    libncurses-dev zlib1g-dev zlib1g libzstd-dev libzstd1
```

**Step 2: Build readsb from Source**
```bash
# Clone the repository
git clone --depth 20 https://github.com/wiedehopf/readsb.git
cd readsb

# Build package
export DEB_BUILD_OPTIONS=noddebs
dpkg-buildpackage -b -ui -uc -us

# Install
sudo dpkg -i ../readsb_*.deb
```

**Step 3: Configure Beast Mode Downloader**

**Basic Beast Data Download:**
```bash
# Connect to ADSB.lol beast output (port 1337)
readsb --net-only \
    --net-connector=out.adsb.lol,1337,beast_in \
    --lat=YOUR_LAT --lon=YOUR_LON \
    --write-json=/tmp/adsb_data/ \
    --write-json-every=1 \
    --quiet
```

**Advanced Configuration with MLAT:**
```bash
# Connect to both beast and MLAT data streams
readsb --net-only \
    --net-connector=out.adsb.lol,1337,beast_in \
    --net-connector=out.adsb.lol,1338,sbs_in_mlat \
    --lat=YOUR_LAT --lon=YOUR_LON \
    --write-json=/tmp/adsb_data/ \
    --write-json-every=0.5 \
    --json-trace-interval=0.1 \
    --write-globe-history=/tmp/adsb_history \
    --heatmap=30 \
    --db-file=/usr/local/share/tar1090/aircraft.csv.gz \
    --forward-mlat \
    --quiet
```

**Step 4: Download Aircraft Database (Optional)**
```bash
sudo mkdir -p /usr/local/share/tar1090
sudo wget -O /usr/local/share/tar1090/aircraft.csv.gz \
    https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz
```

### Option 2: Docker-based Beast Consumer

**Step 1: Create docker-compose.yml for Consumer**
```yaml
version: '3.8'

services:
  adsb-consumer:
    image: ghcr.io/sdr-enthusiasts/docker-adsb-ultrafeeder
    container_name: adsb-consumer
    hostname: adsb-consumer
    restart: unless-stopped
    ports:
      - 8080:80
      - 30005:30005  # Beast output
      - 30003:30003  # SBS output
    environment:
      - LOGLEVEL=error
      - TZ=America/New_York
      
      # Network-only mode (no SDR)
      - READSB_NET_ONLY=true
      
      # Connect to ADSB.lol beast streams
      - READSB_NET_CONNECTOR=out.adsb.lol,1337,beast_in;out.adsb.lol,1338,sbs_in_mlat
      
      # Location for MLAT calculations
      - READSB_LAT=YOUR_LAT
      - READSB_LON=YOUR_LON
      - READSB_ALT=100m
      
      # Data output configuration
      - READSB_WRITE_JSON=/tmp/adsb_data
      - READSB_WRITE_JSON_EVERY=0.5
      - READSB_JSON_TRACE_INTERVAL=0.1
      - READSB_WRITE_GLOBE_HISTORY=/tmp/adsb_history
      - READSB_HEATMAP=30
      
      # Beast output ports
      - READSB_NET_BO_PORT=30005
      - READSB_NET_SBS_PORT=30003
      
      # Forward MLAT
      - READSB_FORWARD_MLAT=true
      
    volumes:
      - ./adsb_data:/tmp/adsb_data
      - ./adsb_history:/tmp/adsb_history
      - ./aircraft.csv.gz:/usr/local/share/tar1090/aircraft.csv.gz:ro
```

**Step 2: Download Aircraft Database**
```bash
wget -O aircraft.csv.gz \
    https://github.com/wiedehopf/tar1090-db/raw/csv/aircraft.csv.gz
```

**Step 3: Start Consumer**
```bash
docker-compose up -d
```

### Data Processing Scripts

**Python Script for Beast Data Processing:**
```python
#!/usr/bin/env python3
import json
import time
import os
from datetime import datetime

def process_aircraft_data(data_dir="/tmp/adsb_data"):
    """Process JSON data from readsb output"""
    aircraft_file = os.path.join(data_dir, "aircraft.json")
    
    if not os.path.exists(aircraft_file):
        print(f"Aircraft file not found: {aircraft_file}")
        return
    
    try:
        with open(aircraft_file, 'r') as f:
            data = json.load(f)
        
        print(f"Timestamp: {datetime.fromtimestamp(data['now'])}")
        print(f"Aircraft count: {len(data['aircraft'])}")
        
        for aircraft in data['aircraft']:
            if 'lat' in aircraft and 'lon' in aircraft:
                icao = aircraft.get('hex', 'Unknown')
                callsign = aircraft.get('flight', 'Unknown').strip()
                lat = aircraft.get('lat', 0)
                lon = aircraft.get('lon', 0)
                alt = aircraft.get('alt_baro', 'Unknown')
                
                # GPS signal quality indicators
                nic = aircraft.get('nic', 'N/A')  # Navigation Integrity Category
                rc = aircraft.get('rc', 'N/A')   # Radius of Containment
                rssi = aircraft.get('rssi', 'N/A')  # Signal strength
                
                print(f"ICAO: {icao}, Callsign: {callsign}, "
                      f"Pos: {lat:.4f},{lon:.4f}, Alt: {alt}, "
                      f"NIC: {nic}, RC: {rc}, RSSI: {rssi}")
        
    except Exception as e:
        print(f"Error processing data: {e}")

if __name__ == "__main__":
    while True:
        process_aircraft_data()
        time.sleep(5)
```

## Key Features Available in Beast Mode Data

### Signal Quality Data
- **RSSI** (Received Signal Strength Indicator)
- **NIC** (Navigation Integrity Category) - GPS accuracy
- **RC** (Radius of Containment) - Position uncertainty in meters
- **NAC_P** (Navigation Accuracy Category - Position)
- **NAC_V** (Navigation Accuracy Category - Velocity)
- **SIL** (Surveillance Integrity Level)

### Data Formats Available
1. **Beast Binary** - Raw, timestamp + signal strength preserved
2. **JSON** - Processed aircraft states with all metadata
3. **SBS/BaseStation** - Text format for compatibility
4. **Globe History** - Historical traces in JSON format

## Troubleshooting

### Common Issues

**1. Connection Refused to ADSB.lol**
```bash
# Check if ports are accessible
telnet out.adsb.lol 1337
telnet out.adsb.lol 1338
```

**2. No Data Appearing**
```bash
# Check readsb logs
sudo journalctl -u readsb -f

# For Docker
docker logs -f container_name
```

**3. Gain Optimization**
```bash
# Enable auto-gain for feeders
adsblol-env set ADSB_GAIN auto

# For manual readsb
readsb --gain=auto-verbose ...
```

### Best Practices

1. **For Feeders:**
   - Use auto-gain for optimal reception
   - Set accurate coordinates for MLAT
   - Use privacy mode if desired (`--privacy`)
   - Monitor with graphs1090 for statistics

2. **For Consumers:**
   - Don't create feedback loops (separate instances)
   - Use appropriate JSON intervals for your needs
   - Monitor disk space for history files
   - Process data in separate scripts/containers

3. **Data Quality:**
   - Filter by NIC values for GPS accuracy requirements
   - Use RSSI for signal strength analysis
   - Consider RC (Radius of Containment) for position uncertainty

## Network Ports Reference

### ADSB.lol Services
- **1337** - Beast binary output (aggregated)
- **1338** - SBS/MLAT input (aggregated)
- **30004** - Beast reduce input (for feeders)
- **31090** - MLAT client connection (for feeders)

### Local readsb Ports
- **30005** - Beast output
- **30003** - SBS output  
- **30002** - Raw output
- **8080** - Web interface (when using containers)

This comprehensive guide should get you set up with both feeding data to ADSB.lol and consuming their aggregated beast mode data for research purposes, including access to GPS signal strength and NIC values.