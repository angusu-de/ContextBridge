// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  ContextBridgeHTTPError,
  ContextBridgeWorkflowClient,
} from "./contextbridge-workflow-client.mjs";

const job = {
  contract_version: "contextbridge.job.v1",
  source: "external-workflow-test",
  requirements: { task: "generation", provider: "ollama" },
  payload: {
    provider: "ollama",
    prompt: "Reply exactly WORKFLOW-OK",
    output: { mode: "text", max_bytes: 4096 },
  },
  max_attempts: 1,
};

{
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ body, key: request.headers["idempotency-key"] });
    if (requests.length === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"id":"job-real-socket-recovery","status":"queued"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const client = new ContextBridgeWorkflowClient({
      relayURL: `http://127.0.0.1:${address.port}`,
      token: "producer-token",
      timeoutMS: 1000,
    });
    const result = await client.submit(job, "socket-loss:v1");
    assert.equal(result.jobID, "job-real-socket-recovery");
    assert.equal(result.recovered, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
  } finally {
    server.close();
    await once(server, "close");
  }
}

{
  const requests = [];
  const client = testClient(async (_url, options) => {
    requests.push(options);
    if (requests.length === 1) throw new TypeError("socket closed after admission");
    return jsonResponse({ id: "job-recovered", status: "queued" });
  });
  const result = await client.submit(job, "order-42:v1");
  assert.equal(result.jobID, "job-recovered");
  assert.equal(result.recovered, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].headers["Idempotency-Key"], "order-42:v1");
  assert.equal(requests[1].headers["Idempotency-Key"], "order-42:v1");
}

{
  let calls = 0;
  const client = testClient(async () => {
    calls += 1;
    return new Response('{"error":"denied"}', { status: 403 });
  });
  await assert.rejects(
    () => client.submit(job, "order-43:v1"),
    (error) => error instanceof ContextBridgeHTTPError && error.status === 403,
  );
  assert.equal(calls, 1, "HTTP failures must not be retried automatically");
}

{
  let calls = 0;
  const client = testClient(async () => {
    calls += 1;
    return new Response("denied", { status: 500, headers: { "content-length": String(2 << 20) } });
  });
  await assert.rejects(
    () => client.submit(job, "order-oversized-error:v1"),
    (error) => error instanceof ContextBridgeHTTPError && error.status === 500,
  );
  assert.equal(calls, 1, "an unreadable HTTP failure body must not turn into a transport retry");
}

{
  const admissions = new Map();
  const bodies = new Map();
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const key = options.headers["Idempotency-Key"];
    if (bodies.has(key) && bodies.get(key) !== options.body) {
      return new Response('{"error":"idempotency_conflict"}', { status: 409 });
    }
    bodies.set(key, options.body);
    if (!admissions.has(key)) admissions.set(key, `job-${admissions.size + 1}`);
    return jsonResponse({ id: admissions.get(key), status: "queued" });
  };
  const firstProcess = testClient(fetchImpl);
  const restartedProcess = testClient(fetchImpl);
  const first = await firstProcess.submit(job, "invoice-9000:v1", { recoverAmbiguous: false });
  const recovered = await restartedProcess.submit(job, "invoice-9000:v1", { recoverAmbiguous: false });
  assert.equal(first.jobID, recovered.jobID, "restart with the same operation must recover one durable job");
  assert.equal(calls, 2);

  const changed = structuredClone(job);
  changed.payload.prompt = "Different logical work";
  await assert.rejects(
    () => restartedProcess.submit(changed, "invoice-9000:v1", { recoverAmbiguous: false }),
    (error) => error instanceof ContextBridgeHTTPError && error.status === 409,
  );
}

{
  const client = testClient(async (_url, options) => {
    if (options.method === "POST") return jsonResponse({ id: "job-wait", status: "queued" });
    return jsonResponse({ id: "job-wait", status: "completed", result: { output: { text: "WORKFLOW-OK" } } });
  });
  const accepted = await client.submit(job, "wait-test:v1");
  const completed = await client.wait(accepted.jobID, { pollMS: 50, timeoutMS: 500 });
  assert.equal(completed.result.output.text, "WORKFLOW-OK");
}

await assert.rejects(() => testClient(() => {}).submit(job, "contains space"), /visible ASCII/u);
await assert.rejects(() => testClient(() => {}).submit(job, " trimmed:v1"), /visible ASCII/u);
assert.throws(() => testClient(() => {}, { relayURL: "http://relay.example.test" }), /HTTPS/u);
assert.throws(() => testClient(() => {}, { relayURL: "https://user:secret@relay.example.test" }), /credentials/u);

console.log("ContextBridge external workflow client tests passed.");

function testClient(fetchImpl, overrides = {}) {
  return new ContextBridgeWorkflowClient({
    relayURL: "https://relay.example.test",
    token: "producer-token",
    fetchImpl,
    timeoutMS: 1000,
    ...overrides,
  });
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
