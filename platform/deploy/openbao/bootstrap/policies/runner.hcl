# AppRole "runner" (D-03 sections 8 and 8.2). Its own secrets; verifies Run Contracts. It can NOT
# read the LiteLLM master key, model provider keys or the GitHub App key, and it can NOT sign.
# The run's short-lived single-repository GitHub token comes from the worker as a response-wrapped
# token; unwrapping is authenticated by that token itself, so no policy line is needed
# (QUESTIONS #44, design/ADR-M25 §2.11). The token never enters a sandbox.
path "kv/data/runner/*" {
  capabilities = ["read"]
}

path "transit/verify/run-contract" {
  capabilities = ["update"]
}

# Public key only.
path "transit/keys/run-contract" {
  capabilities = ["read"]
}
