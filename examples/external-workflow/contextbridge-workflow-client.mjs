// SPDX-License-Identifier: Apache-2.0
// Dependency-free producer client for workflow engines and private backends.

import { readBoundedText } from "../server-app/bounded-response.mjs";

const DEFAULT_MAX_REQUEST_BYTES = 1 << 20;
const DEFAULT_MAX_RESPONSE_BYTES = 1 << 20;
const DEFAULT_TIMEOUT_MS = 10_000;

export class ContextBridgeHTTPError extends Error {
  constructor(status, detail) {
    super(`ContextBridge returned HTTP ${status}: ${detail}`);
    this.name = "ContextBridgeHTTPError";
    this.status = status;
  }
}

export class ContextBridgeWorkflowClient {
  constructor({
    relayURL,
    token,
    fetchImpl = globalThis.fetch,
    timeoutMS = DEFAULT_TIMEOUT_MS,
    maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  }) {
    this.relayURL = validateRelayURL(relayURL);
    this.token = requiredText(token, "producer token");
    if (typeof fetchImpl !== "function") throw new TypeError("a fetch implementation is required");
    this.fetch = fetchImpl;
    this.timeoutMS = boundedInteger(timeoutMS, 100, 120_000, "timeoutMS");
    this.maxRequestBytes = boundedInteger(maxRequestBytes, 1024, 64 << 20, "maxRequestBytes");
    this.maxResponseBytes = boundedInteger(maxResponseBytes, 1024, 64 << 20, "maxResponseBytes");
  }

  // operationID belongs to the external workflow. Reuse it only for the same
  // logical action and byte-equivalent job. A transport failure is retried at
  // most once with the exact serialized bytes and key; HTTP errors are never
  // retried automatically.
  async submit(job, operationID, { recoverAmbiguous = true } = {}) {
    const key = validateOperationID(operationID);
    const body = encodeBoundedJSON(job, this.maxRequestBytes);
    const attempts = recoverAmbiguous ? 2 : 1;
    let firstAmbiguousError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const accepted = await this.requestJSON("POST", "/v1/cluster/jobs?compact=1", body, {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        });
        const jobID = validateJobID(accepted?.id);
        return { job: accepted, jobID, recovered: attempt > 1 };
      } catch (error) {
        if (error instanceof ContextBridgeHTTPError || attempt === attempts) throw error;
        firstAmbiguousError = error;
      }
    }
    throw firstAmbiguousError ?? new Error("ContextBridge submission outcome is unknown");
  }

  job(jobID) {
    return this.requestJSON("GET", `/v1/cluster/jobs/${encodeURIComponent(validateJobID(jobID))}?compact=1`);
  }

  async wait(jobID, { timeoutMS = 60_000, pollMS = 500 } = {}) {
    const id = validateJobID(jobID);
    const deadline = Date.now() + boundedInteger(timeoutMS, 100, 86_400_000, "timeoutMS");
    const interval = boundedInteger(pollMS, 50, 60_000, "pollMS");
    for (;;) {
      const current = await this.job(id);
      if (current.status === "completed") return current;
      if (["failed", "cancelled"].includes(current.status)) {
        throw new Error(`ContextBridge job ${id} ended as ${current.status}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`ContextBridge job ${id} did not finish before the wait deadline; it was not resubmitted or cancelled`);
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  async requestJSON(method, path, body, extraHeaders = {}) {
    let response;
    try {
      response = await this.fetch(this.relayURL + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...extraHeaders,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMS),
        redirect: "error",
      });
    } catch (error) {
      throw new Error(`ContextBridge transport outcome is unknown: ${safeMessage(error)}`);
    }
    let raw;
    try {
      raw = await readBoundedText(response, this.maxResponseBytes, "ContextBridge response");
    } catch (error) {
      if (!response.ok) {
        throw new ContextBridgeHTTPError(response.status, `response body unavailable: ${safeMessage(error)}`);
      }
      throw error;
    }
    if (!response.ok) {
      throw new ContextBridgeHTTPError(response.status, raw.slice(0, 4096));
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`ContextBridge returned invalid JSON: ${safeMessage(error)}`);
    }
  }
}

function encodeBoundedJSON(value, maximumBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("job must be one JSON object");
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new RangeError(`job exceeds ${maximumBytes} bytes`);
  }
  return encoded;
}

function validateRelayURL(value) {
  const parsed = new URL(requiredText(value, "relayURL"));
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  if (parsed.username || parsed.password) throw new Error("relay URL must not contain credentials");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("relay URL must use HTTPS unless it is loopback");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function validateOperationID(value) {
  const id = String(value ?? "");
  if (!/^[!-~]{1,200}$/u.test(id)) {
    throw new TypeError("operationID must contain 1-200 visible ASCII characters without spaces");
  }
  return id;
}

function validateJobID(value) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) || id.includes("..")) {
    throw new TypeError("job ID does not match the ContextBridge identifier contract");
  }
  return id;
}

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\r\n\0]/u.test(normalized)) {
    throw new TypeError(`${label} is required and must be one line`);
  }
  return normalized;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
