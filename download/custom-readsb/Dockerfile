FROM debian:bookworm-slim as builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    git \
    build-essential \
    pkg-config \
    librtlsdr-dev \
    libusb-1.0-0-dev \
    libncurses5-dev \
    zlib1g-dev \
    libzstd-dev \
    librrd-dev \
    protobuf-c-compiler \
    libprotobuf-c-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Use the SAME source as the pre-built image (Mictronics readsb-protobuf)
RUN git clone --depth 1 https://github.com/Mictronics/readsb-protobuf.git
WORKDIR /src/readsb-protobuf

# Build with 20-bit aircraft hash (1M entries vs 65K default)  
RUN make AIRCRAFT_HASH_BITS=20 RTLSDR=yes

FROM ghcr.io/sdr-enthusiasts/docker-readsb-protobuf:latest

# Replace the readsb binary with our custom-built version
COPY --from=builder /src/readsb-protobuf/readsb /usr/local/bin/readsb

# Keep the original entrypoint from the base image