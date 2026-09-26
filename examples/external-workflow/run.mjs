// SPDX-License-Identifier: Apache-2.0
// Example: node run.mjs ORDER-OR-EVENT-ID

import { ContextBridgeWorkflowClient } from "./contextbridge-workflow-client.mjs";

const operationID = process.argv[2] || process.env.CONTEXTBRIDGE_OPERATION_ID;
if (!operationID) {
  console.error("Usage: node run.mjs STABLE-OPERATION-ID");
  process.exit(2);
}

const client = new ContextBridgeWorkflowClient({
  relayURL: requiredEnv("CONTEXTBRIDGE_RELAY_URL"),
  token: requiredEnv("CONTEXTBRIDGE_PRODUCER_TOKEN"),
});

const request = {
  contract_version: "contextbridge.job.v1",
  source: "external-workflow-example",
  requirements: { task: "generation", provider: "ollama" },
  payload: {
    provider: "ollama",
    prompt: "Reply exactly with EXTERNAL-WORKFLOW-OK and nothing else.",
    output: { mode: "text", max_bytes: 4096 },
  },
  max_attempts: 1,
};

try {
  const accepted = await client.submit(request, operationID);
  console.error(`${accepted.recovered ? "Recovered" : "Accepted"} durable job ${accepted.jobID}`);
  const completed = await client.wait(accepted.jobID);
  console.log(completed.result?.output?.text ?? "");
} catch (error) {
  console.error(`ContextBridge workflow failed: ${error.message}`);
  process.exit(1);
}

function requiredEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
