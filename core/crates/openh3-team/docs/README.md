# openh3-team

多 Agent 协作模块：一个团队 = 一个 Lead + N 个 Teammate，共享任务板与邮箱，Lead 派单、Teammate 执行、完成后通知 Lead 汇总。

## 文档维护与历史资料

下方模块链接是阅读入口；接口与行为以当前源码和测试为准。阶段性规划和修复日志单独作为历史资料保留，不代表当前进度或设备环境：

- [Phase 1 调研与开发计划](./phase1/README.md)：保留原始契约、审计与里程碑，供源码注释和历史分析引用。
- [Phase 2 修复记录](./phase2/bugfix.md)：记录当时的分支、问题与操作，不能把“未提交”等旧状态视为当前状态。

历史文件保持原路径以免破坏引用；不执行其中的旧机器路径、进程终止或发布命令作为当前操作步骤。

## 架构

```
                ┌───────────────────────────────────┐
                │          HTTP REST (/api/teams)   │
                └───────────────┬───────────────────┘
                                │
                      ┌─────────▼─────────┐
                      │   TeamSession     │  每 team 一份（内存）
                      │  (session.rs)     │
                      └─┬────────┬────────┘
                        │        │
              ┌─────────▼──┐  ┌──▼──────────────┐
              │ Scheduler  │  │  TeamMcpServer  │ 127.0.0.1:随机端口
              │(scheduler) │  │  (mcp/server)   │ Agent 通过 TCP+JSON-RPC 连接
              └─┬────────┬─┘  └────┬────────────┘
                │        │         │
      ┌─────────▼┐  ┌────▼──────┐  │  调用 8 个 MCP tool
      │ Mailbox  │  │ TaskBoard │  │  (send_message / task_* / ...)
      │(SQLite)  │  │ (SQLite)  │  │
      └──────────┘  └───────────┘  │
                                   │
                          持久化：teams / mailbox / team_tasks 三张表
```

## 模块

- **[HTTP API](./api.md)** — REST 端点、请求/响应字段、错误码
- **[内部调度](./internals.md)** — 状态机、wake→dispatch 时序、已知 bug
- **[MCP 通信](./mcp.md)** — agent ↔ 后端协作协议、工具清单、后端 GAP 分析
- **[前端接入指南](./frontend-guide.md)** — 客户端该做什么、不该做什么

## 前端必读

1. **Team/Agent 所有增删改，都是普通 REST**，客户端不需要任何专属调度/状态机逻辑。
2. **用户→agent 发消息 = 单聊**：走 `POST /api/conversations/{conversation_id}/messages`，`conversation_id` 从 `TeamAgentResponse.conversation_id` 取。team 模块不提供消息端点。
3. **Agent 消息历史也走单聊**：`GET /api/conversations/{conversation_id}/messages`。
4. **实时状态只走 WebSocket**（`team.agentStatusChanged` / `team.agentSpawned` / ...），HTTP 不提供轮询状态接口。
5. **MCP 是后端 ↔ agent 进程之间的事，浏览器不直接接触**（见 [mcp.md](./mcp.md)）。历史阶段记录中的功能缺口不能直接作为当前能力清单。
