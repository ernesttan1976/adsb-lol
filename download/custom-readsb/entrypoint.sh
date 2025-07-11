#!/bin/bash

# Build readsb command line from environment variables
ARGS="--net"  # CRITICAL: Enable networking

# Basic settings
if [ -n "$READSB_DEVICE_TYPE" ]; then
    ARGS="$ARGS --device-type=$READSB_DEVICE_TYPE"
fi

if [ "$READSB_NET_ONLY" = "true" ]; then
    ARGS="$ARGS --net-only"
fi

if [ -n "$READSB_NET_CONNECTOR" ]; then
    ARGS="$ARGS --net-connector=$READSB_NET_CONNECTOR"
fi

if [ -n "$READSB_LAT" ]; then
    ARGS="$ARGS --lat=$READSB_LAT"
fi

if [ -n "$READSB_LON" ]; then
    ARGS="$ARGS --lon=$READSB_LON"
fi

if [ -n "$READSB_MAX_RANGE" ]; then
    ARGS="$ARGS --max-range=$READSB_MAX_RANGE"
fi

# Network settings
if [ -n "$READSB_NET_BEAST_OUTPUT_PORT" ]; then
    ARGS="$ARGS --net-bo-port=$READSB_NET_BEAST_OUTPUT_PORT"
fi

if [ -n "$READSB_NET_BEAST_INPUT_PORT" ]; then
    ARGS="$ARGS --net-bi-port=$READSB_NET_BEAST_INPUT_PORT"
fi

if [ -n "$READSB_NET_HEARTBEAT" ]; then
    ARGS="$ARGS --net-heartbeat=$READSB_NET_HEARTBEAT"
fi

# Performance settings
if [ -n "$READSB_INTERACTIVE_TTL" ]; then
    ARGS="$ARGS --interactive-ttl=$READSB_INTERACTIVE_TTL"
fi

if [ -n "$READSB_STATS_EVERY" ]; then
    ARGS="$ARGS --stats-every=$READSB_STATS_EVERY"
fi

# JSON output
if [ -n "$READSB_WRITE_JSON_EVERY" ]; then
    ARGS="$ARGS --write-json-every=$READSB_WRITE_JSON_EVERY"
fi

if [ -n "$READSB_JSON_LOCATION_ACCURACY" ]; then
    ARGS="$ARGS --json-location-accuracy=$READSB_JSON_LOCATION_ACCURACY"
fi

# Output directory
ARGS="$ARGS --write-json=/run/readsb"

# Quiet mode
if [ "$READSB_QUIET" = "true" ]; then
    ARGS="$ARGS --quiet"
fi

echo "Starting readsb with AIRCRAFT_HASH_BITS=20 (1M entries)"
echo "Command: /usr/local/bin/readsb $ARGS"

exec /usr/local/bin/readsb $ARGS