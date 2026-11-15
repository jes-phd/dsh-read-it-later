// Host 侧入口：注册 /api/read-it-later RPC（绑定 + 发送），UI 在 client.js。
import { mountRpc } from './lib/rpc.mjs';

// 必须声明 connection 依赖，才能访问 ctx.connection.fetch.register。
export const inject = ['connection'];

export function apply(ctx) {
  mountRpc(ctx);
}
