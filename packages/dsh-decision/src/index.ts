/**
 * task-147 —— 包入口（此前不存在，这就是 import("@cc01cc/dsh-decision") 解析不到的原因）。
 *
 * 为什么要有它：cordis 加载插件 = 解析包名 → 取该模块的 name / inject / apply 导出。
 * 本包的插件形状早就写好了（src/host/config.ts 的 inject / apply），但那些导出没有从**包根**
 * 暴露出来，main / exports 也没声明 ⇒ 装进 profile 只能拿到一个空 lib/。
 *
 * 入口只做转发，不放逻辑：真正的装载语义仍归 host/config.ts，这样单测钉的还是同一份实现。
 */
export { apply, inject } from "./host/config.ts";

/**
 * 插件标识。与参考包一致（dsh-notification/index.js 的 export const name = "dsh-notification"）：
 * 用不带 scope 的短名，避免 cordis 内部按包名做 identity 时把 @cc01cc/ 也算进去。
 */
export const name = "dsh-decision";
