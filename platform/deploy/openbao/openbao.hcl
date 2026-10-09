# OpenBao server configuration (D-03 sections 8.1 and 10; tasks A02 and A03).
# The server starts uninitialised and sealed. Initialisation (Shamir 3-of-2), Transit and
# AppRoles are done by openbao/bootstrap.sh (task A03, design/ADR-M19).

ui = false

# Integrated storage (Raft), single node. Data lives in the named volume.
storage "raft" {
  path    = "/openbao/file"
  node_id = "openbao-1"
}

# TLS on the Compose network (task A10, design/ADR-M63, QUESTIONS #20). The certificate (names
# openbao and 127.0.0.1) comes from the job openbao-tls-init: a throw-away CA on development
# machines and in CI, the company CA on the server. Renewal without a restart: tls.sh reload
# (SIGHUP). Every client verifies the CA; there is no plain listener on the network.
listener "tcp" {
  address         = "0.0.0.0:8200"
  tls_cert_file   = "/openbao/tls/server.pem"
  tls_key_file    = "/openbao/tls/server-key.pem"
  tls_min_version = "tls12"
}

# Key-holder listener: reachable only inside the container (docker compose exec), never from
# the Compose network or the host. Only here are the key-share endpoints without a token open:
# creating a new root token from key shares and rekeying (bootstrap.sh root-token, runbook T11
# sections 5 and 8). OpenBao disables them by default (2.5+); on the main listener they stay
# disabled.
listener "tcp" {
  address                                  = "127.0.0.1:8210"
  tls_disable                              = true
  disable_unauthed_generate_root_endpoints = false
  disable_unauthed_rekey_endpoints         = false
}

# File audit device on its own named volume (openbao-audit). Every request and response is
# logged; secret values are HMAC-hashed, never written in clear. Declared here, not through
# the API. Long-term retention and copying to evidence storage: tasks A10 and E05.
audit "file" "file" {
  options {
    file_path = "/openbao/logs/audit.log"
    mode      = "0600"
  }
}

api_addr     = "https://openbao:8200"
cluster_addr = "https://openbao:8201"

# Recommended with integrated storage (memory-mapped files).
disable_mlock = true
