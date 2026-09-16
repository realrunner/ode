export interface SocketModeLifecycle {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

interface SlackSocketModeWatchdogOptions {
  reconnectTimeoutMs: number;
  onReconnectTimeout: (trigger: string) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function watchSlackSocketModeConnection(
  client: SocketModeLifecycle,
  options: SlackSocketModeWatchdogOptions
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

  const handleClose = () => waitForReconnect("close");
  const handleReconnecting = () => waitForReconnect("reconnecting");
  const handleDisconnected = () => waitForReconnect("disconnected");

  client.on("connected", handleConnected);
  client.on("close", handleClose);
  client.on("reconnecting", handleReconnecting);
  client.on("disconnected", handleDisconnected);

  return () => {
    clearReconnectTimer();
    client.off("connected", handleConnected);
    client.off("close", handleClose);
    client.off("reconnecting", handleReconnecting);
    client.off("disconnected", handleDisconnected);
  };
}
