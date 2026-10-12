# zebfin-server: API + view-only wallet service. Build from backend/:
#   docker build -t zebfin-server .
FROM rust:1-bookworm AS build
WORKDIR /src
# clang for secp256k1's C code; protoc in case a dependency regenerates protobufs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p zebfin-server \
 && cp target/release/zebfin-server /usr/local/bin/zebfin-server

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/zebfin-server /usr/local/bin/zebfin-server
# Wallet databases and payment files live on a persistent volume at /data.
ENV ZEBFIN_BIND=0.0.0.0:8080 \
    ZEBFIN_DATA_DIR=/data \
    RUST_LOG=info,schemerz=warn,zcash_client_backend::sync=warn
EXPOSE 8080
CMD ["zebfin-server"]
