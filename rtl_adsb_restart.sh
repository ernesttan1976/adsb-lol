#!/bin/bash
# rtl_adsb_restart.sh - WSL-friendly auto-restart script

while true; do
    echo "$(date): Checking RTL-SDR device..."
    
    # Kill any existing processes using the device
    pkill -f "rtl_adsb" 2>/dev/null
    pkill -f "nc.*30006" 2>/dev/null
    sleep 2
    
    # Test if RTL-SDR is accessible
    if ! rtl_test -t 2>/dev/null; then
        echo "$(date): RTL-SDR device not found, waiting 10 seconds..."
        sleep 10
        continue
    fi
    
    echo "$(date): Starting RTL-ADSB..."
    timeout 60 rtl_adsb -d 0 -p 15 -g 20 -V | nc -l -p 30006
    
    echo "$(date): RTL-ADSB died (exit code: $?), restarting in 5 seconds..."
    sleep 5
done