import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchSlackChannels } from "./slack";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  mock.restore();
});

describe("Slack workspace discovery", () => {
  it("honors Retry-After and continues paginating large channel lists", async () => {
    const urls: string[] = [];
    const pageDelays: number[] = [];
    let requestCount = 0;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      urls.push(String(input));
      requestCount += 1;
      if (requestCount === 1) {
        return Response.json(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "retry-after": "0" } }
        );
      }
      if (requestCount === 2) {
        return Response.json({
          ok: true,
          channels: [
            { id: "C1", name: "one", is_member: true },
            { id: "C2", name: "two", is_member: false },
          ],
          response_metadata: { next_cursor: "next-page" },
        });
      }
      return Response.json({
        ok: true,
        channels: [{ id: "C3", name: "three", is_member: true }],
        response_metadata: { next_cursor: "" },
      });
    }) as unknown as typeof fetch;

    await expect(fetchSlackChannels("xoxb-test", async (ms) => {
      pageDelays.push(ms);
    })).resolves.toEqual([
      { id: "C1", name: "one", is_member: true },
      { id: "C3", name: "three", is_member: true },
    ]);
    expect(urls).toHaveLength(3);
    expect(new URL(urls[0]!).searchParams.get("limit")).toBe("999");
    expect(new URL(urls[2]!).searchParams.get("cursor")).toBe("next-page");
    expect(pageDelays).toHaveLength(1);
    expect(pageDelays[0]).toBeGreaterThanOrEqual(3000);
    expect(pageDelays[0]).toBeLessThan(3250);
  });

  it("reports the endpoint and retry duration when rate-limit retries are exhausted", async () => {
    globalThis.fetch = mock(async () => Response.json(
      { ok: false, error: "ratelimited" },
      { status: 429, headers: { "retry-after": "0" } }
    )) as unknown as typeof fetch;

    await expect(fetchSlackChannels("xoxb-test")).rejects.toThrow(
      "Slack API conversations.list rate limited after 4 attempts; retry after 0 seconds"
    );
  });
});
