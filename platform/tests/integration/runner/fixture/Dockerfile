# Fixture sandbox image of the C04 live egress test (ADR-M25). Stands in for a project image: it
# runs as the sandbox user, probes the network from inside the sandbox, prints the results, then
# keeps serving on port 8000 like the Agent Server. Never used outside the tests.
FROM docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
COPY probe.sh /probe.sh
# Project images own /workspace as the sandbox user (ADR-M25 §2.3): Docker copies this owner into
# the run's empty workspace volume when the sandbox is created.
RUN mkdir /workspace && chown 10001:10001 /workspace
USER 10001:10001
CMD ["sh", "/probe.sh"]
