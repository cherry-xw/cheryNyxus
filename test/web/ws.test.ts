import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsClient } from "../../web/src/services/ws";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send = vi.fn();
  open(): void { this.onopen?.(); }
  close(): void { this.onclose?.(); }
}

describe("WsClient reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("window", {
      location: { protocol: "http:", hostname: "localhost", host: "localhost:8183" },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes /api/config and uses the replacement worker token on reconnect", async () => {
    const configs = [
      { wsPort: 8182, webPort: 8183, transport: "binary", sessionToken: "old-token" },
      { wsPort: 8182, webPort: 8183, transport: "binary", sessionToken: "new-token" },
    ];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => configs.shift() }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new WsClient();
    await client.connect();
    const first = FakeWebSocket.instances[0]!;
    expect(first.url).toContain("old-token");
    first.open();

    const reconnected = client.waitForNextReconnect();
    first.close();
    await vi.advanceTimersByTimeAsync(2000);
    const second = FakeWebSocket.instances[1]!;
    expect(second.url).toContain("new-token");
    second.open();
    await expect(reconnected).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/config", { cache: "no-store" });
    client.disconnect();
  });
});
