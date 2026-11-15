// Host 侧入口：注册 /api/read-it-later RPC（绑定 + 发送），UI 在 client.js。
import { mountRpc, restoreArms } from './lib/rpc.mjs';
import { startMonitor } from './lib/monitor.mjs';
import { startFeishuEvents, stopFeishuEvents } from './lib/feishu-events.mjs';

// 必须声明 connection 依赖，才能访问 ctx.connection.fetch.register。
export const inject = ['connection'];

export function apply(ctx) {
  mountRpc(ctx);
  // 把上次没等完的「预处理发送」接回来（Host 重启 / 升级后不至于白等一场）。
  void restoreArms(ctx).catch((error) => {
    console.warn('[read-it-later] restoreArms failed:', error?.message ?? error);
  });
  // 状态监控：盯所有会话的「完成一轮 / 卡在需要决定」，按设置往默认机器人推。
  startMonitor();
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
