## 变更摘要

<!-- 说明问题、解决方式和用户可见结果。 -->

## 规范与范围

- 关联 Issue：
- 适用 accepted spec / ADR：
- 明确不在本 PR 范围内的事项：

## 验证

<!-- 只列实际运行的命令和结果；说明未运行项及原因。 -->

- [ ] `npm test`
- [ ] `npm run review`
- [ ] `npm run lint:addon`（涉及扩展代码或 Manifest）
- [ ] `npm run package`（涉及构建或发布）
- [ ] `git diff --check`

## 隐私与安全检查

- [ ] 未提交 Cookie、Token、请求头、HAR、原始响应、对话、真实用量、账号数据或发布者凭据。
- [ ] 未增加主动 `/backend-api/wham/*` 请求或 reset credit consume 操作。
- [ ] 跨 MAIN/ISOLATED 边界的新字段已在两侧白名单化，并覆盖存储与导出测试。
- [ ] 权限、外部通信、远程代码和数据传输边界未扩大；若扩大，已更新 accepted spec 与隐私/安全文档。
- [ ] 截图和测试夹具只使用合成数据。

## 发布影响

- [ ] 已更新 `CHANGELOG.md` 的 `Unreleased`（如有用户可见变化）。
- [ ] 已说明 schema、迁移、环境变量、制品或发布流程影响。
- [ ] 未提交 `release/`、`.tmp/`、签名制品或发布者专用材料。

## 未验证项与剩余风险

<!-- 没有则写“无”。 -->
