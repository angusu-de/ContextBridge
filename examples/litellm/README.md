# Optional LiteLLM gateway

ContextBridge works without LiteLLM. This example is for operators who already
use LiteLLM and want one additional model alias, `contextbridge`, backed by CB's
policy and execution pool.

## 1. Generate the two files

Run this on the machine where the local ContextBridge service and LiteLLM will
run:

```sh
contextbridge integrate litellm \
  --write-config ./litellm-contextbridge.yaml \
  --write-env ./.contextbridge-litellm.env
```

The YAML is secret-free and may be reviewed or versioned. The environment file
contains the local CB credential, is created without overwrite, and must stay
private.

## 2. Load the private environment

Bash or zsh:

```sh
set -a
. ./.contextbridge-litellm.env
set +a
```

PowerShell:

```powershell
Get-Content .\.contextbridge-litellm.env | ForEach-Object {
  $name, $value = $_ -split '=', 2
  Set-Item -Path "Env:$name" -Value $value
}
```

The generated values contain no newline or NUL characters. Do not use this
generic loader for arbitrary untrusted `.env` files.

## 3. Start LiteLLM

Using an independently installed LiteLLM proxy:

```sh
litellm --config ./litellm-contextbridge.yaml
```

Then point an OpenAI-compatible client at LiteLLM and select model
`contextbridge`. ContextBridge itself still listens locally and authenticates
every forwarded request.

Before involving LiteLLM, verify the downstream CB endpoint without inference:

```sh
contextbridge integrate openai --check
```

Add `--live` only when one real bounded inference is intended.

## Boundaries

- This example covers the Chat Completions compatibility path implemented by
  CB; it is not a claim that CB implements every LiteLLM or OpenAI endpoint.
- LiteLLM's upstream routing, retries and budgets remain LiteLLM evidence.
  ContextBridge is authoritative only after a request enters CB.
- Native CB jobs remain the richer interface for durable lifecycle, artifacts,
  E2EE reservations, route evidence and receipts.
- Run LiteLLM natively on the same host for this loopback example. Inside a
  container, `127.0.0.1` points to the container. Use a deliberately secured
  network endpoint for any cross-host or container deployment rather than
  exposing CB's local listener casually.

References: [LiteLLM proxy quick start](https://docs.litellm.ai/docs/proxy/docker_quick_start),
[`model_list` configuration](https://docs.litellm.ai/docs/proxy/configs), and
[custom OpenAI-compatible endpoints](https://docs.litellm.ai/docs/providers/openai_compatible).
