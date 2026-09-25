# Policy "platform-admin": daily operator work (D-03 section 10.2). Tokens come only from the
# token role platform-admin and live at most ADMIN_TOKEN_MAX_TTL (1 hour).
# No sys/ paths: no policy, mount, audit, seal or root-token changes (those need a root token).
# No Transit export, backup, rotation or deletion. No secret destruction.

# Store and update platform secrets (for example the GitHub App key, the LiteLLM master key).
path "kv/data/*" {
  capabilities = ["create", "read", "update"]
}

path "kv/metadata/*" {
  capabilities = ["read", "list"]
}

# Deliver AppRole credentials to a process. Issuing a secret ID is a sensitive operation: it is
# audited, and the runbook (T11 section 8) says who may do it and how.
path "auth/approle/role/+/role-id" {
  capabilities = ["read"]
}

path "auth/approle/role/+/secret-id" {
  capabilities = ["update", "list"]
}

path "auth/approle/role/+/secret-id-accessor/lookup" {
  capabilities = ["update"]
}

# Revoke a lost or leaked secret ID.
path "auth/approle/role/+/secret-id-accessor/destroy" {
  capabilities = ["update"]
}

# Public key of the Run Contract signing key.
path "transit/keys/run-contract" {
  capabilities = ["read"]
}
