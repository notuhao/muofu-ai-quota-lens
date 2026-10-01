# Changelog

本项目记录面向用户的显著变化。尚未发布的工作先进入 `Unreleased`。

## Unreleased

### Added

- 路由诊断加入 `fast_convo`、requested model experience、turn use case / mode、reasoning 状态与时长，并使用组合信号提示“疑似受限”。
- 新增账户/会话限制最新状态：主 rate-limit 的 `allowed` / `limit_reached` / `used_percent`、reached type、overage / spend-control 状态，以及 `conversation/init` 的 blocked features、model limits、limits progress 和模型可用性摘要。
- 浮层折叠状态下仍显示账户硬限制/能力限制、路由异常、额度异常与 reset-credit 临期/过期提示。
- 独立保存最新主限额摘要；即使当前页面没有按日 Analytics，也能显示已用比例与重置时间。
- 被动观察 ChatGPT 页面已加载的 reset credits 数量、最近已观测到期时间与详情新鲜度；不提供 consume 操作。
- 添加公共贡献指南、Issue forms、Pull Request 模板和私密漏洞报告入口。
- 添加可复现构建、Mozilla linter、持续集成和 GitHub draft Release 流程。

### Changed

- 产品更名为 **Muofu AI Quota Lens**，仓库和 Release 制品统一使用 `muofu-ai-quota-lens` 命名。
- Usage 首选入口保持为当前 `/codex/settings/usage`；捕获完成语义改为“主限额可独立完成，按日 Credits 为增强证据”，并继续识别 `/codex/cloud/settings/analytics` 作为兼容路径。
- `/wham/usage` 按当前响应语义只从顶层 `rate_limit` 提取主窗口，顶层 `additional_rate_limits` / ChatPass 不再参与主周额度选择。
- 会话记录兼容当前 `messages[]` 结构；HAR 从长任务中途开始录制时仍可沿当前 turn 解析可见元数据。
- GitHub Release 明确区分未签名开发制品、审计用源码包与 Mozilla 签名版本。
- 发布者专用投递材料与公共源码、源码 ZIP 和 Release 解耦。

### Fixed

- 修复新版 `/wham/usage` 多额度域被递归混合后，reserve / ChatPass 等附加窗口可能误选为主周额度的问题。
- 修复新 Usage 页面没有加载旧按日 Analytics 时，扩展持续显示“未完成捕获”而无法展示已经观测到的主限额的问题。
- 修复后到 hook 状态可能把已经捕获的直接主限额状态覆盖回“等待”的竞态。
- 窗口时长或结束时间发生显著重排时，即使 `cycleStart` 未变化也会切断同周期增量和异常比较。
- source ZIP 改用显式脚本白名单，避免本地 Python 缓存或其他忽略文件混入发布制品。

### Security

- reset credit 响应只保留数量、最近到期时间和观测时间；丢弃 credit/profile ID、头像、标题、描述及原始数组。
- 保持纯被动边界：不读取认证信息，不主动调用私有用量 API，不调用 reset credit consume 接口。
- 收紧套餐、重置与窗口比较规则，避免未知套餐、跨套餐历史或非周窗口产生误导结论。

## 0.2.1 — 2026-08-30

### Added

- 重置感知时间线：区分计划/自然重置、提前重置、窗口重排、套餐上下文变化。
- 用户可在本机标记“主动重置 / 套餐切换 / 分析边界”，并可撤销最近标记。
- 新周期保护期：边界日首个点只作暂定展示，不触发套餐参考或个人历史升降判断。
- 周期边界事件最多保留 100 条，且只允许固定类型、时间、可选套餐 ID，不保存自由文本。

### Changed

- 当前容量估计一旦有同周期增量样本，就完全优先使用增量估计，避免边界日按日汇总固定偏移。
- 个人历史基线优先使用历史周期内增量估计，并排除跨套餐、明显不同窗口和用户标记套餐切换之前的历史。
- CSV 快照导出增加 `comparison_eligible`、`boundary_day_ambiguous` 与 `transition_type` 字段。
- 清空本地数据同时删除手动周期边界。

### Fixed

- 修复重置发生在一天中途时，按日 Credits 可能把重置前同一天用量带入新周期、导致首个点高估的问题。
- 修复套餐切换后旧套餐周期仍可能污染当前“个人历史基线”的问题。

## 0.2.0 — 2026-08-30

### Added

- 纯被动 Codex Credits 观察：只读取 ChatGPT Analytics 页面自身响应。
- 捕获健康状态、端点最近观测时间、按日区间合并和页面会话配对。
- Plus、Pro 5x、Pro 20x 的版本化非官方社区参考区间。
- 用户自定义套餐、Credits 校准值、标签和 5%–50% 比较阈值。
- 自动套餐提示读取；模糊 Pro 不再自动猜测 5x/20x。
- 周容量时间序列、周期散点和每日 Credits 三类图表；单点即可绘制。
- 社区参考带、自定义基准线和个人完整周期中位线。
- 同周期回退、异步更新和异常跳变诊断。
- 参考基准证据文档。

### Changed

- 产品名称更新为 `Codex Credits & Route Watch`。
- Credits“刷新”改为打开或重新加载 Analytics 页面。
- 权限缩减为 `storage` 与单一 `https://chatgpt.com/*` 主机权限。
- 禁止隐私窗口运行；扩展页面 CSP 收紧。
- 历史样本不足时不再隐藏全部图表。

### Removed

- Bearer Token 读取与正则提取。
- 主动 `/backend-api/wham/*` 请求和 `Authorization` 头。
- `activeTab` 权限、`chat.openai.com` 权限与所有后台运行代码。

### Security

- Credits 元数据在 MAIN 与 ISOLATED world 两次白名单化。
- 新增长度、行数、窗口数和被动会话保留上限。
- 新增“扩展不会发起 Credits 网络请求”的回归测试和静态检查。