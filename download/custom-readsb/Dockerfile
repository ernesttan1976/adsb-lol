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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 https://github.com/wiedehopf/readsb.git -b dev
WORKDIR /src/readsb

# Build with 20-bit aircraft hash (1M entries vs 16K default)
RUN make AIRCRAFT_HASH_BITS=20 RTLSDR=yes

FROM debian:bookworm-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    librtlsdr0 \
    libusb-1.0-0 \
    libncurses6 \
    zlib1g \
    libzstd1 \
    netcat-traditional \
    && rm -rf /var/lib/apt/lists/*

# Copy the enhanced readsb binary
COPY --from=builder /src/readsb/readsb /usr/local/bin/readsb

COPY ./entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]