export interface DiscordGatewayLifecycle {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

interface DiscordGatewayWatchdogOptions {
  reconnectTimeoutMs: number;
  onReconnectTimeout: (trigger: string) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function watchDiscordGatewayConnection(
  client: DiscordGatewayLifecycle,
  options: DiscordGatewayWatchdogOptions
): () => void {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutReported = false;

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimer(reconnectTimer);
    reconnectTimer = null;
  };

  const handleConnected = () => {
    clearReconnectTimer();
    timeoutReported = false;
  };

  const waitForReconnect = (trigger: string) => {
    if (reconnectTimer || timeoutReported) return;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      timeoutReported = true;
      options.onReconnectTimeout(trigger);
    }, options.reconnectTimeoutMs);
  };

  const handleDisconnect = () => waitForReconnect("shardDisconnect");
  const handleReconnecting = () => waitForReconnect("shardReconnecting");
  const handleInvalidated = () => waitForReconnect("invalidated");

  client.on("shardDisconnect", handleDisconnect);
  client.on("shardReconnecting", handleReconnecting);
  client.on("invalidated", handleInvalidated);
  client.on("shardReady", handleConnected);
  client.on("shardResume", handleConnected);

  return () => {
    clearReconnectTimer();
    client.off("shardDisconnect", handleDisconnect);
    client.off("shardReconnecting", handleReconnecting);
    client.off("invalidated", handleInvalidated);
    client.off("shardReady", handleConnected);
    client.off("shardResume", handleConnected);
  };
}
