# WeKnora 官方托管版手工知识 draft 参数异常：最小复现与兼容性确认请求

> 仅供提交至官方技术支持 / 私有工单。请先隐去 tenant、KB 和 document 标识；不要公开凭据及私人 KB 信息。

## 环境
- 官方托管 API: https://weknora.weixin.qq.com/api/v1
- 连接方式: 官方托管云 API（客户端透传 X-API-Key）；非用户自建开源服务器
- 请求：POST /knowledge-bases/{sandbox_kb}/knowledge/manual；PUT /knowledge/manual/{sandbox_doc}
- 沙盒：新建独立测试知识库，与业务知识库隔离
- 代码参考：Tencent/WeKnora internal/application/service/knowledge_create.go（开源版会校验 status 为 draft/publish，draft 保存为 disabled/unindexed）

## 复现方法
1. 在独立沙盒创建 Markdown 文档，使用 JSON {"title":"sandbox","content":"# test","status":"draft"}。
2. GET /knowledge/{doc_id}：检查 metadata.status、parse_status、enable_status。
3. PUT /knowledge/manual/{doc_id}，保持 title/content 不变，仍发送 status:"draft"。
4. 单独对该沙盒文档 PUT 非法 status:"invalid_phaseb_validation_probe"（无需改变内容）并观察是否拒绝。

## 实际结果（已实测）
- POST/PUT 请求包含 status:"draft"，响应成功却保存 metadata.status="publish"；状态进一步变为 parse_status="completed"、enable_status="enabled"。
- 非法 status 请求未返回 400，操作成功且版本从 2 增至 3，metadata.status 仍是 publish。
- 对开发适配器 WeKnoraClient._request 作了短暂、仅记录 status 字段的运行时插桩，在 requests.Session.request 之前捕获到 status=draft；托管端响应 publish，版本再加至 4。
- 插桩现已完全回退，与原文件 SHA256 一致；没有打印正文、请求头、密钥。业务库未写入。

## 预期结果
- status=draft 保存为 metadata.status=draft / parse_status=draft / enable_status=disabled，不能自动开始索引。
- 非法 status 返回 400，不能悄然发布。
- 需明确托管版在这些路由上是否支持草稿功能，以及与当前开源版语义差异。

## 请求官方协助确认
1. 托管版当前后端/API 版本、这些路由是否启用 draft 模式。
2. status 字段是被忽略、映射、强制覆盖，还是被 API 网关规范化；请检查相应沙盒请求的服务端日志。
3. 是否有**公开且支持、原子安全**的未发布知识创建/更新接口；或文档中是否应注明托管版限制。
4. 是否能提供用于回归验证的沙盒权限和正确参数示例，以及后续上线计划。
5. 如果不支持未发布草稿，明确建议客户端采用什么隔离流程，避免临时索引泄露。

## 安全发布决定
**NO-GO**：在官方确认并经过托管版原始认证请求端到端验收前，保持 MCP_WRITE_ENABLED=false 和 MCP_DRAFT_CONTRACT_VERIFIED=false，不提供生产写入工具。禁止先发布再禁用的替代方案，因为存在短时间可检索风险。

该报告不会自动发布到公开 GitHub Issues，需先获得用户同意并检查是否含隐私信息。
