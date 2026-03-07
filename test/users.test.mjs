import test from "node:test";
import assert from "node:assert/strict";
import { request } from "undici";
import { startServer, stopServer } from "../index.js";

// Start server, call endpoint, ensure JSON response
test("GET /api/users/by-auth-uid/:authUid responds with JSON", async (t) => {
  const server = startServer(0); // random available port
  const addr = server.address();
  const port = addr.port;

  try {
    const authUid = "test-auth-uid-123";
    const res = await request(
      `http://127.0.0.1:${port}/api/users/by-auth-uid/${encodeURIComponent(authUid)}`,
    );

    // Accept 200/404/500 depending on backend availability; ensure content-type JSON
    assert.ok(
      [200, 404, 500].includes(res.statusCode),
      `Unexpected status ${res.statusCode}`,
    );

    const contentType = res.headers["content-type"] || "";
    assert.ok(
      String(contentType).includes("application/json"),
      "Expected JSON response",
    );

    const body = await res.body.text();
    // parse JSON safely
    let json = null;
    try {
      json = JSON.parse(body);
    } catch (e) {
      // fail if body isn't JSON
      assert.fail("Response body is not valid JSON");
    }

    // Expect at least an object with message or roles
    assert.ok(typeof json === "object");
    // test passes if we got a valid JSON object back
  } finally {
    stopServer();
  }
});
