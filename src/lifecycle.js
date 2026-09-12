// 优雅退出:收到终止信号后停止接收新请求,等待在途连接与写入结束再退出。
// createShutdown 返回可测试的关闭函数;attachGracefulShutdown 把它接到 SIGTERM/SIGINT。
export function createShutdown(server, store, { logger = () => {} } = {}) {
  let closing = false;
  return async function shutdown(reason = "shutdown") {
    if (closing) return false;
    closing = true;
    logger(`[lifecycle] 收到 ${reason},停止接收新请求,等待在途写入结束`);
    // 先停止接收新连接,再关闭空闲的 keep-alive 连接;在途请求允许完成
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.();
    await closed;
    // 等所有排队中的落盘写入完成
    await store.drain();
    logger("[lifecycle] 在途请求与写入已完成");
    return true;
  };
}

export function attachGracefulShutdown(server, store, { logger = console.log, forceExitMs = 5000 } = {}) {
  const shutdown = createShutdown(server, store, { logger });
  const onSignal = (signal) => {
    const timer = setTimeout(() => {
      logger(`[lifecycle] 等待超过 ${forceExitMs}ms,强制退出`);
      process.exit(1);
    }, forceExitMs);
    timer.unref();
    shutdown(signal).then(
      () => {
        clearTimeout(timer);
        process.exit(0);
      },
      (error) => {
        clearTimeout(timer);
        console.error("[lifecycle] 退出前清理失败:", error);
        process.exit(1);
      }
    );
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
  return shutdown;
}
