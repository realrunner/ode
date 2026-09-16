import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { watchSlackSocketModeConnection } from "./socket-mode-watchdog";

type TimerCallback = () => void;

function createTimerHarness() {
  let callback: TimerCallback | null = null;
  return {
    setTimer: ((next: TimerCallback) => {
      callback = next;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => {
      callback = null;
    }) as typeof clearTimeout,
    fire: () => {
      const current = callback;
      callback = null;
      current?.();
    },
    hasTimer: () => callback !== null,
  };
}

describe("Slack Socket Mode watchdog", () => {
  test("allows the SDK to reconnect without restarting the runtime", () => {
    const client = new EventEmitter();
    const timers = createTimerHarness();
    let timeoutCount = 0;
    const dispose = watchSlackSocketModeConnection(client, {
      reconnectTimeoutMs: 60_000,
      onReconnectTimeout: () => timeoutCount++,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    client.emit("close");
    expect(timers.hasTimer()).toBe(true);
    client.emit("connected");
    expect(timers.hasTimer()).toBe(false);
    timers.fire();
    expect(timeoutCount).toBe(0);

    dispose();
  });

  test("reports one timeout per outage and rearms after a connection", () => {
    const client = new EventEmitter();
    const timers = createTimerHarness();
    const triggers: string[] = [];
    const dispose = watchSlackSocketModeConnection(client, {
      reconnectTimeoutMs: 60_000,
      onReconnectTimeout: (trigger) => triggers.push(trigger),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    client.emit("close");
    client.emit("reconnecting");
    timers.fire();
    client.emit("reconnecting");
    timers.fire();
    expect(triggers).toEqual(["close"]);

    client.emit("connected");
    client.emit("disconnected");
    timers.fire();
    expect(triggers).toEqual(["close", "disconnected"]);

    dispose();
  });

  test("dispose prevents shutdown events from requesting recovery", () => {
    const client = new EventEmitter();
    const timers = createTimerHarness();
    let timeoutCount = 0;
    const dispose = watchSlackSocketModeConnection(client, {
      reconnectTimeoutMs: 60_000,
      onReconnectTimeout: () => timeoutCount++,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    client.emit("close");
    dispose();
    client.emit("disconnected");
    timers.fire();
    expect(timeoutCount).toBe(0);
    expect(timers.hasTimer()).toBe(false);
  });
});
