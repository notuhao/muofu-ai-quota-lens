# Muofu AI Quota Lens

**本地观察 ChatGPT Codex 用量、重置机会与路由/执行元数据**

[![CI](https://github.com/notuhao/muofu-ai-quota-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/notuhao/muofu-ai-quota-lens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Muofu AI Quota Lens 是一款本地优先的 Firefox 扩展。它被动观察 ChatGPT 页面已经收到的 Codex 用量与会话响应，在浏览器本地整理主限额、Credits、重置机会以及可见的路由/执行元数据。

项目独立、非官方，不隶属于 OpenAI 或 Mozilla，也未获得其认可或背书。

## 功能

- 汇总当前周窗口、已用比例、重置时间、Credits、Tokens、Turns 与缓存命中率。
- 结合当前点、同周期增量和完整历史周期估算周容量，并明确显示证据强度。
- 对比非官方社区参考、用户自定义校准和个人完整历史周期中位数。
- 识别自然重置、提前重置、窗口重排与套餐变化；边界日首点进入保护期，避免把跨周期日汇总直接用于结论。
- 被动显示服务端响应中可见的 reset credits 数量、最近**已观测**到期时间和详情观测状态；不会主动消耗重置机会。
- 将当前 `/wham/usage` 的主 `rate_limit` 与顶层 `additional_rate_limits` / ChatPass 等额度域分离，避免附加窗口污染主周额度。
- 即使当前页面没有加载旧的按日 Analytics，也可直接显示主限额已用比例与重置时间；Credits 容量推算只在有按日证据时生成。
- 综合请求/响应模型字段、`fast_convo`、thinking effort、reasoning 时长、requested experience 与 turn use case 做本地启发式诊断；任何单一字段或短时长都不会被当作隐性限制的充分证据。
- 被动保存最新账户/会话限制摘要：`allowed`、`limit_reached`、主额度 `used_percent`、`rate_limit_reached_type`、overage / spend-control 状态，以及 `conversation/init` 的 blocked features、model limits 与 limits progress；Usage 与 init 两个来源分别覆盖更新。
- 浮层折叠时仍保留异常/临期提示，不保存提示词、回答、附件或原始网络载荷。
- 提供本地图表、受控分析边界、CSV 导出和一键清空。

## 被动与本地意味着什么

扩展只观察 ChatGPT 页面自身发起并收到的限定同源响应。它不会：

- 读取或保存 Cookie、Bearer Token、请求头或其他登录凭据；
- 构造 `Authorization` 头；
- 主动调用 `/backend-api/wham/*` 私有用量接口；
- 调用 reset credit 的 consume 接口或代替用户执行重置；
- 连接开发者服务器、加载远程代码、发送遥测或展示广告。

响应会在页面 MAIN world 首次缩减为白名单字段，并在 ISOLATED world 再次校验后才写入 Firefox `storage.local`。扩展只保存计算和展示所需的摘要；reset credit ID、用户 ID、头像、标题、描述和原始详情数组都会被丢弃。

`manifest.json` 仅申请：

- `storage`：在本机保存设置和有界观察记录；
- `https://chatgpt.com/*`：在 ChatGPT 页面运行被动观察脚本。

完整数据边界见 [PRIVACY.md](PRIVACY.md)，安全模型见 [SECURITY.md](SECURITY.md)。

## 使用

1. 按 [INSTALL.md](INSTALL.md) 安装扩展。
2. 打开当前 Usage 页面：<https://chatgpt.com/codex/settings/usage>。
3. 等待页面自行加载用量数据，再打开扩展弹窗查看捕获状态。当前 ChatGPT 页面若已经自行加载 `/wham/usage`，扩展也可直接取得主限额。
4. 主限额可独立显示；只有页面同时加载按日 Credits 数据时才生成 Credits 容量估计。需要更完整证据时打开诊断台。
5. 主动使用重置机会或切换套餐后，可在诊断台记录本地分析边界，并重新加载 Usage 页面取得边界后的新观察。

扩展仍识别旧的 `/codex/cloud/settings/analytics` 页面作为兼容路径，但公共入口和“打开/重载”操作以 `/codex/settings/usage` 为准。被动模式只能看到页面实际加载的响应；没有被页面加载的到期详情会明确显示为“尚未观测”，不会被推断或补造。

## 安装与 Release 边界

正式使用应优先选择 Mozilla 签名版本。GitHub Releases 中名称含 `unsigned` 的 XPI 是未签名的开发/审查制品，只适合临时安装和复核，不能等同于可在标准 Firefox 中持久安装的正式版本。source ZIP 用于审计和复现构建，不是可直接安装的扩展。

签名版本、源码临时加载与 GitHub Release 制品的区别见 [INSTALL.md](INSTALL.md)。

## 开发

需要 Node.js 22+、Python 3、系统 `zip` 与 `unzip`。

```bash
npm ci
npm run check
npm run lint:addon
npm run package
```

`npm run package` 在 `release/` 生成确定性的未签名 XPI、source ZIP 和 SHA-256 校验和。项目没有运行时依赖，也不对运行时代码做转译、合并或压缩。

项目当前只面向 Firefox Desktop，未声明 `gecko_android`。`npm run lint:addon` 会把 Mozilla linter 的 Android 140/142 最低版本差异作为唯一已知允许警告列出；任何其他 error、notice 或 warning 都会失败。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题不要创建公开 Issue，请按 [SECURITY.md](SECURITY.md) 私密报告。

## 重要限制与合规风险

- ChatGPT Web 的页面、私有端点和字段可能随时变化，扩展可能停止捕获或只得到部分数据。
- 尚未针对 Firefox for Android 适配或上架。
- 页面 MAIN world 不可信；所有 Credits、reset credits 和路由字段都是页面可观察值，不是密码学证明或 OpenAI 官方额度证明。
- 周容量估算和[社区参考](REFERENCE_BASELINES.md)不是账号权益、保证额度或计费依据。
- OpenAI 的适用服务条款可能限制自动化提取和逆向分析。被动、本地处理与开源并不自动意味着相关使用获得授权或符合条款；使用者和贡献者应自行确认其账号、地区与用途所适用的规则。详见 [SECURITY.md](SECURITY.md#服务条款与私有接口风险)。
- 路由/执行元数据只能说明页面载荷中出现了哪些字段；`fast_convo`、模型字段差异或短 reasoning 时长单独出现时都不能证明隐性限制或底层物理推理后端。

第三方来源、资产来源与商标说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目采用 [MIT License](LICENSE)。