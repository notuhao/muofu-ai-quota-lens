# 隐私说明 / Privacy Notice

更新日期：2026-10-01

## 核心承诺

Muofu AI Quota Lens 没有开发者服务器、遥测、广告或远程代码，**不会把任何用户数据传输到本地浏览器之外**。

Muofu AI Quota Lens has no developer-operated server, telemetry, advertising, or remote code. It does **not transmit user data outside the local browser**.

Firefox Manifest 因此声明：

```json
"data_collection_permissions": {
  "required": ["none"]
}
```

扩展只申请 `storage` 和 `https://chatgpt.com/*`，不申请 Cookie、`webRequest`、下载、剪贴板、调试器、原生消息或全站访问权限，也不在隐私窗口运行。

## 被动观察

扩展只观察 ChatGPT 页面自身已经发起并收到的限定同源响应。它不会：

- 读取或保存 Cookie、Bearer Token、请求头、`client-bootstrap` 或其他登录凭据；
- 构造 `Authorization` 请求头；
- 主动调用 `/backend-api/wham/*` 私有用量接口；
- 调用 reset credit consume 接口或代替用户执行重置；
- 代替用户向 OpenAI 补发页面未加载的详情请求。

页面响应可能在 MAIN world 的内存中被短暂解析，但在离开页面世界前会被缩减为白名单字段；ISOLATED world 会在本地保存前再次校验。查询字符串、响应头和原始载荷不会进入扩展存储。

## Credits 与 reset credits

Credits / 限额观察最多保留主 `rate_limit` 的周期起止与用量百分比、按日 Credits/Tokens/Turns 汇总、套餐提示、捕获时间和由这些数据计算出的本地诊断结果。当前响应若还包含顶层 `additional_rate_limits`、ChatPass 或其他额度域，它们不会作为主周额度窗口写入该状态。扩展可单独保存一个最新主限额摘要；没有按日数据时不会伪造 Credits 容量估计。

## 账户与会话限制状态

扩展还会保存一个**最新账户/会话限制状态**，由两个页面已有响应独立覆盖更新：

- `/backend-api/wham/usage`：仅保留 `rate_limit.allowed`、`rate_limit.limit_reached`、主窗口 `used_percent` / reset / window seconds、`rate_limit_reached_type`、`credits.overage_limit_reached`、`spend_control.reached`，以及有界的 `model_usage` 可用性摘要；
- 精确的 `POST /backend-api/conversation/init`：仅保留 `blocked_features`、`model_limits`、`limits_progress` 与 default / intended default model slug 的有界摘要。

两个来源互不清空：只捕获到 Usage 不会删除最近一次 init 状态，反之亦然。不会保存 Usage 中的 user/account ID、邮箱、Credits balance、完整 additional rate limits、ChatPass 原始结构，或 init 中的 banner、profile、完整响应。

reset credits 只保留一个最新摘要状态：

- 服务端报告的可用数量；
- 最近**已观测**到期时间；
- 已观测到的不设到期项数量；
- 摘要与详情各自的最后观测时间；
- 页面是否曾加载详情。

不会保存 reset credit ID、profile user ID、头像 URL、授予人、标题、描述、原始数组或原始响应。详情数量不会替代服务端摘要数量；页面未加载详情时，扩展不会主动请求或推断到期时间。

## 路由与执行观察

路由功能会在页面内临时检查限定会话端点的请求/响应流与同站 WebSocket，以提取模型标识和关联 ID。只有以下白名单元数据能够进入扩展存储：

- 请求模型和 thinking effort；
- response、resolved、server、assistant 与 default model 标识；
- `fast_convo`、requested model experience、turn use case / mode；
- reasoning 状态与已完成时长；
- 请求 ID、会话 ID、计划类型、观测时间、来源和由上述白名单字段计算的诊断状态。

不会保存或导出：

- 提示词、回答正文或消息内容；
- 附件名称、附件内容或文件 URL；
- 原始请求体、原始响应体、WebSocket 原始帧或 HAR；
- Cookie、Token、请求头、页面 bootstrap 数据；
- 账号姓名、邮箱、付款信息或其他个人资料。

## 本地存储与保留

Firefox `storage.local` 中最多保存：

- 1 个最新主限额摘要、1 个最新账户/会话限制状态与最多 500 个 Credits 快照；
- 200 条路由/执行观察；
- 1 个最新 reset credits 摘要状态；
- 4 个尚在页面内配对的临时捕获会话；
- 最多 100 个受控周期边界标记；
- 套餐、参考模式、校准值、异常阈值和界面设置。

周期边界标记只包含固定类型、时间、可选套餐档位和本地 ID，不接受自由文本。历史数据只用于本地计算、图表和用户主动导出；扩展不会自动上传导出文件。

## 用户控制

用户可以分别关闭 Credits 观察、路由/执行观察和页面浮层，可以撤销本地边界标记，也可以随时导出或清空本地数据。卸载扩展会由 Firefox 按其存储规则处理扩展数据。

在提交 Issue 或安全报告前，请用合成值替代真实用量，并删除 Cookie、Token、完整 HAR、提示词、回答、账号标识和其他个人信息。

## 第三方页面与服务条款

ChatGPT 页面及 OpenAI 服务自身的数据处理不由本扩展控制。本说明只涵盖扩展代码的本地处理行为。

扩展依赖页面可观察的私有响应，字段可能随时变化。OpenAI 的适用服务条款也可能限制自动化提取和逆向分析；纯被动、本地处理和开源并不会自动消除该风险或构成 OpenAI 授权。请结合自己的账号、地区和用途判断适用规则。更多说明见 [SECURITY.md](SECURITY.md#服务条款与私有接口风险)。

本项目独立、非官方，与 OpenAI 或 Mozilla 不存在隶属、授权或背书关系。