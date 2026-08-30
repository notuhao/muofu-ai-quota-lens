# Muofu AI Quota Lens 安全政策与设计

## 支持范围

| 版本 | 安全更新 |
|---|---|
| 默认分支及最新发布版本 | 支持 |
| 更早版本、第三方修改版和未注明来源的构建 | 不保证 |

GitHub Release 中的未签名 XPI 仅用于开发和审查，不代表 Mozilla 签名版本。报告问题时请注明版本、安装来源和 Firefox 版本，但不要附带账号数据。

## 私密报告漏洞

请使用 GitHub 的 [Private Vulnerability Reporting](https://github.com/notuhao/muofu-ai-quota-lens/security/advisories/new) 私密提交安全问题，不要创建公开 Issue，也不要在公开讨论中披露可利用细节。

报告应尽量包含：

- 受影响版本、Firefox 版本与安装来源；
- 使用合成数据即可复现的最小步骤；
- 潜在影响与建议修复方向；
- 已删除敏感内容的错误信息或截图。

不要提交 Cookie、Bearer Token、请求头、完整 HAR、原始响应、提示词、回答、附件、真实用量、账号 ID、邮箱或付款信息。如果 GitHub 私密报告入口暂不可用，请不要改用公开 Issue 披露漏洞；等待仓库维护者启用该入口。

维护者会通过 GitHub Security Advisory 协作确认影响、准备修复并协调披露。普通故障和功能建议使用 Issue forms。

## 权限与运行范围

- API 权限仅为 `storage`。
- 主机权限仅为 `https://chatgpt.com/*`。
- 不申请 `activeTab`、`tabs`、`debugger`、`webRequest`、Cookie、下载、剪贴板、原生消息或全站权限。
- 不在隐私窗口运行，不创建后台 Service Worker。
- 扩展页面 CSP 为 `script-src 'self'; object-src 'none'; base-uri 'none'`。

任何扩大权限、增加外部网络通信、认证信息访问或远程代码的变更都不是普通重构，必须先更新 accepted spec、隐私说明和相应测试。

## 被动网络边界

Credits 功能不会主动发起私有用量请求。MAIN world 只观察 ChatGPT 页面自身发出的限定同源 GET 响应，包括：

- `/backend-api/wham/usage`；
- `/backend-api/wham/analytics/daily-workspace-usage-counts`，且只接受按日或缺省分组；
- `/backend-api/wham/rate-limit-reset-credits` 的详情响应。

`/backend-api/wham/rate-limit-reset-credits/consume` 不会被观察、调用或暴露为用户操作。扩展不读取请求头、Cookie、Bearer Token、`client-bootstrap` 或其他身份凭据。

响应在 MAIN world 输出前与 ISOLATED world 持久化前分别经过白名单清洗。reset credit 的 profile、用户、credit ID、头像、标题、描述和原始详情必须在首次清洗时丢弃。

模型路由功能只处理限定的 ChatGPT 会话流、会话记录和明确允许的同站 WebSocket；它不修改请求、响应、模型选择或账户额度。

## 代码与数据约束

- 不使用 `eval`、`new Function`、动态导入、远程脚本、内联脚本或外部分析服务。
- 页面主世界无法调用扩展 API，只能通过同源 `window.postMessage` 发送结构化白名单字段。
- ISOLATED world 校验 `event.source`、`event.origin`、消息来源、协议版本和字段类型。
- Credits 响应、会话记录、SSE 事件、WebSocket 帧、对象深度、节点数量、日记录数量和字符串长度均有上限。
- 本地保留上限为 500 个 Credits 快照、200 条路由观察、100 个受控周期边界标记、1 个 reset credits 最新状态和 4 个临时配对会话。
- 打包审计拒绝路径穿越、重复成员、符号链接、`.tmp` 和发布者私有材料进入公共归档。

## 威胁与证据边界

页面 MAIN world 本身不可信。ChatGPT 页面或同页脚本可以替换浏览器 API、伪造响应或构造同源消息。双重白名单限制敏感内容进入扩展存储，但不能把页面观测升级为密码学证明。

因此：

- Credits、reset credits 数量和到期时间都只是最近观察到的服务端字段，不是官方权益证明；
- 扩展不会根据本地时钟自行减少服务端数量，过期缓存只会提示重载；
- 自然重置、主动重置、套餐切换和窗口重排是分析边界，不应直接解释为异常；
- 边界日汇总可能混合前后周期，首点仅作暂定显示，同周期增量证据优先；
- 路由字段不证明底层物理推理后端；
- 私有端点或字段变化可能导致捕获失败、部分数据或过期显示。

## 服务条款与私有接口风险

本扩展会被动解析 ChatGPT 页面已经收到的私有响应。OpenAI 的 [Terms of Use](https://openai.com/policies/terms-of-use/) 对自动化或程序化提取以及逆向分析设有限制；不同账号类型、地区和用途还可能适用其他协议。访问日期：2026-08-30。

是否允许某个具体使用方式取决于适用条款、事实与法律。开源、无遥测、本地处理和不主动请求私有接口并不自动构成授权，也不能保证符合条款。本说明不是法律意见。用户和贡献者不得借本项目绕过访问控制、扩大抓取范围、自动消耗 reset credits 或收集他人数据，并应在适用规则不允许时停止使用。

ChatGPT Web 与其私有接口也没有向本项目提供稳定性承诺；兼容性修复不得以降低隐私边界或绕过服务控制为代价。

## Add-on 功能审查账号

若 Mozilla 的功能审查需要登录后才能复现，维护者不得共享个人 ChatGPT 凭据。应优先让审查员使用其自有账号，或使用明确获授权的专用测试账号；也可以事先与 Mozilla 确认可接受的合成演示方式。

公开仓库、Issue、源码 ZIP 和 GitHub Release 都不得包含登录凭据、真实用量样本、完整 HAR 或账号相关审查材料。
