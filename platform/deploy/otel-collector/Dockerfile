# OpenTelemetry Collector for the Compose profile "observability" (task A08, design/ADR-M35 §2.4).
# The upstream image has no shell, so Docker cannot run a health check in it. This image copies the
# pinned collector binary onto the pinned busybox the repo already uses (wget and base64 for
# start.sh and the health check). Both stages are pinned by tag and digest.
FROM docker.io/otel/opentelemetry-collector:0.161.0@sha256:b6d2b9a85b1029d05b5ad913150c1f014eed4ae99be81a1813ca5ade4a191913 AS collector

FROM docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
COPY --from=collector /otelcol /otelcol
COPY config.yaml /etc/otelcol/config.yaml
COPY start.sh /start.sh
USER 10001:10001
ENTRYPOINT ["sh", "/start.sh"]
