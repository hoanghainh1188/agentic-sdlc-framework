# OpenBao server configuration (D-03 sections 8.1 and 10; task A02).
# The server starts uninitialised and sealed. Initialisation (Shamir 3-of-2),
# Transit and AppRoles are done by the bootstrap script in task A03.

ui = false

# Integrated storage (Raft), single node. Data lives in the named volume.
storage "raft" {
  path    = "/openbao/file"
  node_id = "openbao-1"
}

# TLS is off on the internal Docker network; the host port is bound to
# 127.0.0.1 by default. TLS is an open item for task A03.
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

api_addr     = "http://openbao:8200"
cluster_addr = "http://openbao:8201"

# Recommended with integrated storage (memory-mapped files).
disable_mlock = true
