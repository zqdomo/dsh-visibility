/**
 * `@local/dsh-visibility` 的 Host 半边。
 *
 * 本插件全部逻辑在浏览器侧：显隐状态存在 localStorage，隐藏动作是给已渲染的
 * 行加 `display:none`。Host 不需要任何路由、服务或模型面，这里留一个空
 * `apply` 只是为了让本包在 Loader 里占一行——客户端模块系统据此把
 * `client.js` 送进浏览器（与 `@deepseek-ai/dsh-client-ui-settings-shell` 同样
 * 的做法）。
 */

/**
 * 空实现：不注册任何 Host 侧能力。
 * @param _ctx - Cordis 上下文（未使用）。
 */
export function apply(_ctx) {}
