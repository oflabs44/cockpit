import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedApp, authedRequest } from "./access";

describe("plane app", () => {
  it("boots and responds to GET /health", async () => {
    const res = await authedApp().fetch(authedRequest("http://plane.test/health"), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the OpenAPI document at GET /doc", async () => {
    const res = await authedApp().fetch(authedRequest("http://plane.test/doc"), env);

    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/health"]).toBeDefined();
  });

  it("sets secure headers on responses", async () => {
    const res = await authedApp().fetch(authedRequest("http://plane.test/health"), env);

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects oversized request bodies with 413", async () => {
    const res = await authedApp().fetch(
      authedRequest("http://plane.test/health", {
        method: "POST",
        body: new Uint8Array(2 * 1024 * 1024),
      }),
      env,
    );

    expect(res.status).toBe(413);
  });

  it("rejects a cross-origin form-encoded POST with 403", async () => {
    const res = await authedApp().fetch(
      authedRequest("http://plane.test/health", {
        method: "POST",
        headers: {
          origin: "http://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "a=1",
      }),
      env,
    );

    expect(res.status).toBe(403);
  });

  it("sets etag on GET but not on other methods or error responses", async () => {
    const getRes = await authedApp().fetch(authedRequest("http://plane.test/health"), env);
    expect(getRes.headers.get("etag")).not.toBeNull();

    // A response the app itself produces (the zod hook's 400), not the SPA asset fallback:
    // with a real ASSETS binding an unmatched POST is answered by the assets service, whose
    // status is not this app's to assert.
    const postRes = await authedApp().fetch(
      authedRequest("http://plane.test/servers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
    );
    expect(postRes.status).toBe(400);
    expect(postRes.headers.get("etag")).toBeNull();
  });
});
