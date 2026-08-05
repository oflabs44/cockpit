import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("plane app", () => {
  it("boots and responds to GET /health", async () => {
    const res = await createApp().request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the OpenAPI document at GET /doc", async () => {
    const res = await createApp().request("/doc");

    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/health"]).toBeDefined();
  });

  it("sets secure headers on responses", async () => {
    const res = await createApp().request("/health");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects oversized request bodies with 413", async () => {
    const res = await createApp().request("/health", {
      method: "POST",
      body: new Uint8Array(2 * 1024 * 1024),
    });

    expect(res.status).toBe(413);
  });

  it("rejects a cross-origin form-encoded POST with 403", async () => {
    const res = await createApp().request("/health", {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "a=1",
    });

    expect(res.status).toBe(403);
  });

  it("sets etag on GET but not on other methods or error responses", async () => {
    const getRes = await createApp().request("/health");
    expect(getRes.headers.get("etag")).not.toBeNull();

    const postRes = await createApp().request("/nonexistent", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    expect(postRes.status).toBe(404);
    expect(postRes.headers.get("etag")).toBeNull();
  });
});
