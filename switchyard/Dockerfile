# Builds NVIDIA NeMo Switchyard's standalone server (switchyard-server crate) from a pinned
# commit, following the repo's own Dockerfile. The server is for demos and local evaluation.
ARG RUST_VERSION=1.96.1
FROM rust:${RUST_VERSION}-bookworm AS builder

ARG SWITCHYARD_REPO=https://github.com/NVIDIA-NeMo/Switchyard.git
ARG SWITCHYARD_COMMIT=171d613bf0fef059b175e6b7772fdba0841dc7b1

WORKDIR /opt/switchyard
RUN git init -q . \
    && git remote add origin "${SWITCHYARD_REPO}" \
    && git fetch -q --depth 1 origin "${SWITCHYARD_COMMIT}" \
    && git checkout -q FETCH_HEAD
RUN cargo build --locked --release -p switchyard-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/switchyard/target/release/switchyard-server /usr/local/bin/switchyard-server
COPY routes.toml /config/routes.toml
ENV HOME=/tmp
USER 1000:1000
EXPOSE 4000
ENTRYPOINT ["switchyard-server", "--host", "0.0.0.0"]
CMD ["--config", "/config/routes.toml", "--port", "4000", "--routing-log-file", "/tmp/routing.jsonl"]
