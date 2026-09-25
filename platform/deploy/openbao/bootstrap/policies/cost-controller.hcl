# AppRole "cost-controller" (D-03 section 8.2). Its own secrets, including the LiteLLM master
# key at kv/cost-controller/litellm-master-key.
path "kv/data/cost-controller/*" {
  capabilities = ["read"]
}
