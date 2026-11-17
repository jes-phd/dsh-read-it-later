// Host 侧入口：注册 /api/read-it-later RPC（绑定 + 发送），UI 在 client.js。
// 说明：这里用带版本查询串的动态 import，避免插件热重载时命中 Node 的 ESM 模块缓存
// （否则改过的 lib/*.mjs 还是老代码，很容易排出「明明改了却没生效」的怪现象）。
export const inject = ['connection'];

export async function apply(ctx) {
  const bust = `?v=${Date.now()}`;
  const { mountRpc, restoreArms } = await import(`./lib/rpc.mjs${bust}`);
  const { startMonitor } = await import(`./lib/monitor.mjs${bust}`);
  const { startFeishuEvents, stopFeishuEvents } = await import(`./lib/feishu-events.mjs${bust}`);

  mountRpc(ctx);
  // 把上次没等完的「预处理发送」接回来（Host 重启 / 升级后不至于白等一场）。
  void restoreArms(ctx).catch((error) => {
    console.warn('[read-it-later] restoreArms failed:', error?.message ?? error);
  });
  // 状态监控：盯所有会话的「完成一轮 / 卡在需要决定」，按设置往默认机器人推。
  startMonitor(ctx);
  // 飞书长连接：卡片按钮点选 / 直接回复数字，都能把选择回填到会话里。
  try {
    startFeishuEvents(ctx);
  } catch (error) {
    console.warn('[read-it-later] 飞书长连接启动失败:', error?.message ?? error);
  }
  ctx.on('dispose', () => {
    try {
      stopFeishuEvents();
    } catch {
      /* ignore */
    }
  });
}
