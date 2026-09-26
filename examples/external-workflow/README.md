<!-- SPDX-License-Identifier: Apache-2.0 -->

# External workflow engines

ContextBridge does not replace n8n, Temporal, GitHub Actions, cron, a PHP
application, or another workflow engine. The external system owns its workflow;
CB owns the lifecycle, placement, leases, policy and finality of each admitted
CB job.

## Copy-paste proof with Node.js 18+

Create one scoped producer credential on the relay host:

```sh
contextbridge integrate relay \
  --subject external-workflow \
  --lifetime-hours 720 \
  --max-queued-jobs 4 \
  --max-jobs-per-hour 60 \
  --write-env ./contextbridge-workflow.env
```

Move that file through a secure channel to the workflow host and load its
variables. Then use a durable business/event ID for one logical action:

```sh
node examples/external-workflow/run.mjs order-2026-0042:v1
```

Running the same command again with the same request recovers the same durable
job. A changed request with the same operation ID is rejected. The client may
repeat an ambiguous submit once, but it uses the exact same serialized bytes
and `Idempotency-Key`; HTTP failures are never retried automatically. Result
polling never resubmits or cancels the job.

Do not generate a new operation ID merely because a process restarted. Do not
reuse an operation ID for different work.

## n8n HTTP Request node

No ContextBridge-specific n8n node is required. Use n8n's built-in HTTP Request
node with:

- method: `POST`
- URL: `https://YOUR-RELAY/v1/cluster/jobs?compact=1`
- header credential: `Authorization: Bearer YOUR_SCOPED_PRODUCER_TOKEN`
- header: `Idempotency-Key: {{$json.operation_id}}`
- body: one native `contextbridge.job.v1` JSON object
- redirect following: disabled

The incoming `operation_id` must be persisted by the workflow's trigger or
business system before submission. Do not use a fresh random value or a retry
execution ID. Generic retries are safe only when both the key and request bytes
remain identical. After acceptance, persist the returned `id` and poll
`GET /v1/cluster/jobs/{id}?compact=1`; polling must not POST the job again.

Keep producer credentials in n8n credentials or another server-side secret
store, never in an exported workflow JSON. Remote relays require HTTPS.

## Authority boundary

| Component | Owns |
| --- | --- |
| External workflow engine | triggers, branches, approvals, schedules and its own retries |
| ContextBridge | admitted job policy, placement, lease state and durable terminal result |
| Selected runtime/provider | execution behavior inside the evidence boundary CB reports |

CB cannot prove that an external workflow triggered only once. The workflow
cannot infer that a timed-out submit did not reach CB. The stable operation ID
connects those two boundaries without turning either system into the other.

Official n8n references: [HTTP Request node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/),
[expressions](https://docs.n8n.io/code/expressions/), and
[credentials](https://docs.n8n.io/credentials/).
