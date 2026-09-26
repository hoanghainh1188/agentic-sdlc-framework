# OpenBao Agent: sidecar of LiteLLM, Compose profile "models" (task C03, design/ADR-M24,
# QUESTIONS #1 option B). It logs in with the AppRole "litellm" and renders LiteLLM's
# configuration, with the provider keys, the master key and the salt key, into a tmpfs file.
# LiteLLM reads that file at start-up. No key goes into .env, the repo, an image or an
# environment variable.
#
# The OpenBao address comes from BAO_ADDR (Compose). No token is written to disk (no sink).

auto_auth {
  method "approle" {
    config = {
      role_id_file_path                   = "/openbao/approle/role_id"
      secret_id_file_path                 = "/openbao/approle/secret_id"
      # The secret ID stays for the next login (it is valid 90 days, ADR-M19 section 2.3).
      remove_secret_id_file_after_reading = false
    }
  }
}

template_config {
  # Missing access or a missing master key: the agent exits, LiteLLM does not start (fail closed).
  exit_on_retry_failure = true
}

template {
  source               = "/openbao/litellm-template/config.ctmpl"
  destination          = "/run/litellm/config.yaml"
  perms                = "0600"
  error_on_missing_key = true
}
