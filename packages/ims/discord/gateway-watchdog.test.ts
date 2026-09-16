import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { watchDiscordGatewayConnection } from "./gateway-watchdog";

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

describe("Discord gateway watchdog", () => {
  test("allows discord.js to reconnect without restarting the runtime", () => {
    const client = new EventEmitter();
    const timers = createTimerHarness();
    let timeoutCount = 0;
    const dispose = watchDiscordGatewayConnection(client, {
      reconnectTimeoutMs: 60_000,
      onReconnectTimeout: () => timeoutCount++,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    client.emit("shardDisconnect");
    expect(timers.hasTimer()).toBe(true);
    client.emit("shardResume");
    expect(timers.hasTimer()).toBe(false);
    timers.fire();
    expect(timeoutCount).toBe(0);

    dispose();
  });

  test("reports one timeout per outage and rearms after shard ready", () => {
    const client = new EventEmitter();
    const timers = createTimerHarness();
    const triggers: string[] = [];
    const dispose = watchDiscordGatewayConnection(client, {
      reconnectTimeoutMs: 60_000,
      onReconnectTimeout: (trigger) => triggers.push(trigger),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    client.emit("shardDisconnect");
    client.emit("shardReconnecting");
    timers.fire();
    client.emit("shardReconnecting");
    timers.fire();
    expect(triggers).toEqual(["shardDisconnect"]);

    client.emit("shardReady");
    client.emit("invalidated");
    timers.fire();
    expect(triggers).toEqual(["shardDisconnect", "invalidated"]);

    dispose();
  });

  test("dispose prevents client destruction from requesting recovery", () => {
    const client = new EventEmitter();
    const timers = createTimerHarness();
    let timeoutCount = 0;
    const dispose = watchDiscordGatewayConnection(client, {
      reconnectTimeoutMs: 60_000,
      onReconnectTimeout: () => timeoutCount++,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    client.emit("shardDisconnect");
    dispose();
    client.emit("invalidated");
    timers.fire();
    expect(timeoutCount).toBe(0);
    expect(timers.hasTimer()).toBe(false);
  });
});
