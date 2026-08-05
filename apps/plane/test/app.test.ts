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
});
