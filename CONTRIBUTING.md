# Muofu AI Quota Lens 贡献指南

感谢你帮助改进 Muofu AI Quota Lens。项目欢迎可复现的缺陷报告、隐私与安全改进、兼容性修复、测试和文档贡献。

## 开始之前

- 先阅读 [README.md](README.md)、[PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。
- 目标设计与已接受约束从 [docs/README.md](docs/README.md) 进入；当前实现事实仍以当前分支的代码、Manifest 和测试为准。
- 搜索已有 Issue，避免重复报告。
- 安全漏洞不要创建公开 Issue，请使用 [Private Vulnerability Reporting](https://github.com/notuhao/muofu-ai-quota-lens/security/advisories/new)。

## 禁止提交敏感数据

Issue、Pull Request、测试夹具、截图和提交记录都不得包含：

- Cookie、Bearer Token、API key、请求头或登录凭据；
- 完整 HAR、原始请求/响应、WebSocket 帧或页面 bootstrap 数据；
- 提示词、回答、附件、真实会话或真实用量明细；
- 账号 ID、姓名、邮箱、头像 URL、付款信息或 AMO 发布者凭据。

请使用最小合成夹具，并把标识符写成显然无效的测试值。无法安全脱敏时，只描述行为，不上传原始材料。

## 本地开发

需要：

- Node.js 22+
- Python 3
- 系统 `zip` 与 `unzip`

```bash
npm ci
npm run check
npm run lint:addon
npm run package
```

常用的快速验证：

```bash
npm test
npm run review
```

行为修复和新功能应先添加能够证明风险的失败测试，再做最小实现。无法运行某项检查时，请在 PR 中说明原因、替代验证和剩余风险。

## 高后果不变量

任何贡献都必须保持以下边界：

1. 扩展只观察 ChatGPT 页面自身已经发起的限定同源请求，不主动调用 `/backend-api/wham/*` 私有用量 API。
2. 不读取 Cookie、Token、`Authorization`、请求头或其他认证信息。
3. 不调用或提供 `/backend-api/wham/rate-limit-reset-credits/consume` 操作。
4. MAIN world 首次白名单化，ISOLATED world 再次清洗；不保存原始载荷、reset credit/profile ID、头像、标题或描述。
5. 不增加开发者服务器、遥测、广告、远程代码或用户数据外传。
6. Manifest 权限保持为 `storage` 与 `https://chatgpt.com/*`；扩大权限必须先更新 accepted spec、隐私/安全说明和测试。
7. 当前首选 Usage 路径是 `/codex/settings/usage`；`/codex/cloud/settings/analytics` 只作为兼容路径。
8. 页面观测、社区参考和路由字段都不能表述为 OpenAI 官方权益、计费结论或物理后端证明。

涉及私有接口兼容性时，也请阅读 [服务条款与私有接口风险](SECURITY.md#服务条款与私有接口风险)。不得用本项目绕过访问控制、扩大抓取范围或收集他人数据。

## 代码与文档约定

- 保持原生、可读代码；不要引入转译、压缩、远程执行或不必要依赖。
- 优先复用现有 sanitizer、contract、存储 key 和测试工具。
- 修改跨 MAIN/ISOLATED 边界的字段时，同步检查 producer、consumer、清洗器、存储、导出、UI 和测试。
- 用户可见变化更新 `CHANGELOG.md` 的 `Unreleased`。
- 版本发布时保持 `manifest.json` 与 `package.json` 一致；普通功能 PR 不自行改版本。
- 不提交 `release/`、`.tmp/`、真实浏览器数据、签名制品或发布者专用材料。
- 新增第三方代码或资产前确认许可证兼容，并更新 `THIRD_PARTY_NOTICES.md`。

## 提交与 Pull Request

提交标题使用 Conventional Commit，说明以中文为主，例如：

```text
fix(credits): 修复套餐变化后的周期比较
docs(security): 补充私有响应风险说明
```

PR 应保持单一主题，并说明：

- 问题与解决方式；
- 涉及的 accepted spec/ADR；
- 实际运行的验证命令与结果；
- 未运行的检查和剩余风险；
- 权限、隐私、存储、迁移、构建或发布影响；
- 截图是否完全使用合成数据。

维护者会优先审查行为、安全、数据最小化和兼容性退化，而不是仅依赖编译或 happy path 结果。
