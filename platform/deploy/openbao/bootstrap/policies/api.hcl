# AppRole "api" (D-03 section 8.2). Only its own secrets and the GitHub App key.
path "kv/data/api/*" {
  capabilities = ["read"]
}

path "kv/data/shared/github-app" {
  capabilities = ["read"]
}
