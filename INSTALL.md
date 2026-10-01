# Muofu AI Quota Lens — Firefox 安装说明

## 选择安装方式

### Mozilla 签名版本

正式使用应优先从 Mozilla Add-ons（AMO）安装签名版本。签名版本可以在标准 Firefox 中持久安装，并沿固定扩展 ID 接收后续更新。背景规则见 Mozilla 的 [Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)。

若项目尚未发布 AMO 签名版本，请使用下面的临时安装方式进行开发或审查，不要把 GitHub Release 中的未签名 XPI 当作正式发行版。

### GitHub Release 制品

[GitHub Releases](https://github.com/notuhao/muofu-ai-quota-lens/releases) 可能提供：

- `muofu-ai-quota-lens-firefox-<version>-unsigned.xpi`：未签名，只用于开发、临时安装和代码审查；
- `muofu-ai-quota-lens-firefox-<version>-source.zip`：可复现构建所需的公共源码，不是扩展安装包；
- `muofu-ai-quota-lens-firefox-<version>-SHA256SUMS.txt`：上述制品的 SHA-256 校验和。

GitHub Release 不会自动把未签名 XPI 变成 Mozilla 签名扩展。标准 Firefox 通常不会持久接受未签名扩展。

## 临时安装未签名版本

1. 在 Firefox 地址栏打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”。
3. 选择解压源码目录中的 `manifest.json`，或选择 Release 中名称含 `unsigned` 的 XPI。
4. 打开 <https://chatgpt.com/codex/settings/usage>，等待页面自行加载用量数据。
5. 打开扩展弹窗，检查被动捕获和详情观测状态。

临时扩展会在 Firefox 完全退出后卸载。旧路径 `/codex/cloud/settings/analytics` 仍被识别用于兼容，但不是首选入口。

## 从源码构建

只需要 Node.js 22+。打包和归档审计都是仓库内的 Node 脚本，不需要 bash、系统 `zip`、`unzip`、`sha256sum` 或 Python。

```bash
npm ci
npm run check
npm run lint:addon
npm run package
npm run audit
```

制品生成在 `release/`。`npm run audit` 会重新校验归档结构、时间戳、成员白名单与 SHA-256 校验和，无需额外的 `sha256sum`。跨平台核对校验和可用任意 SHA-256 工具，校验和文件使用 GNU 格式（`hash␠␠name`）。

`npm run package` 生成的 XPI 仍然未签名。源码 ZIP 用于复现与审计，不能通过“临时载入附加组件”当作 XPI 安装。

构建只依赖 Node.js 22+：`npm ci` 用于安装唯一的开发依赖 `web-ext`（Mozilla linter），打包、归档审计和测试都不需要任何外部工具链。

## 被动捕获说明

扩展中的“打开/重新加载 Usage”只负责导航或重载第一方页面。扩展不会主动请求私有用量接口、读取 ChatGPT 登录凭据或调用 reset credit consume 接口。

若没有观察到数据：

1. 确认当前页面位于 `chatgpt.com` 且账号有权访问 Usage 页面；
2. 完整重载 Usage 页面并等待其自身请求完成；
3. 查看弹窗中的端点和详情观测时间；
4. 不要为了报告问题而导出或上传 Cookie、Token、完整 HAR、对话正文或真实账号数据。

私有页面结构和响应字段可能变化。页面未加载 reset credit 详情时，扩展只能显示已观测到的摘要，不会主动补请求。
