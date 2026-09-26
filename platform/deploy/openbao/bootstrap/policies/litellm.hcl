# AppRole "litellm": the OpenBao Agent sidecar of LiteLLM (task C03, design/ADR-M24,
# QUESTIONS #1 option B). It renders LiteLLM's configuration with the model provider keys, the
# master key and the salt key into a tmpfs file. Read only; nothing else.

# Model provider keys, one entry per provider: kv/litellm/providers/<provider> (field api_key).
path "kv/data/litellm/providers/*" {
  capabilities = ["read"]
}

# List the providers that have a key, so the template adds only their models.
path "kv/metadata/litellm/providers/*" {
  capabilities = ["list"]
}

# LiteLLM's salt key (encrypts credentials LiteLLM stores in its database).
path "kv/data/litellm/salt-key" {
  capabilities = ["read"]
}

# The LiteLLM master key has one source: the Cost Controller's entry (QUESTIONS #1, ADR-M24 §2.1).
path "kv/data/cost-controller/litellm-master-key" {
  capabilities = ["read"]
}
