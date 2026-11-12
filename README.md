# Consensus MCP for DSH

在 DSH 对话中检索论文、委托 Consensus 研究 Agent，并管理研究任务和登录状态。

## 使用

在 DSH 插件管理中安装并启用 **`dsh-consensus`**，打开 Consensus 详情页登录。也可以直接发起研究请求，由插件引导完成授权。

[npm](https://www.npmjs.com/package/dsh-consensus) · [GitHub](https://github.com/Miyamiz39/dsh-consensus)

账号页显示“已登录 / 未登录”，提供登录、刷新状态、退出登录和取消登录操作。更新插件后，重载插件并刷新 DSH 页面即可使用。

## 工具

工具名称统一使用 `mcp__consensus__` 前缀。

| 工具 | 功能 |
| --- | --- |
| `search` | 搜索论文，按相关度返回文献记录、摘要和链接 |
| `create_thread` | 创建研究任务，委托研究 Agent 检索、阅读全文、追踪引文和综合证据 |
| `add_to_thread` | 在已有研究任务中追加后续问题 |
| `get_thread` | 查询研究进度，获取报告和引用 |
| `find_threads` | 列出或搜索账号中的研究任务 |

### 论文检索

用自然语言提出问题，通过 `page_size` 指定论文数量，使用工具中的筛选参数表达用户选择的条件：

```json
{
  "query": "Does resistance training improve glycemic control?",
  "page_size": 20,
  "year_min": 2020,
  "human": true
}
```

搜索也支持将筛选条件放入 `filters` 对象。

### 研究任务

向 `create_thread` 提交完整研究要求：

```json
{
  "input_message": "比较抗阻训练与有氧训练对 2 型糖尿病患者血糖控制的影响，综合随机对照试验与系统综述，并给出带引用的报告。",
  "mode": "pro"
}
```

返回的 `thread_id` 用于调用 `get_thread`。按 `poll_after_seconds` 指定的间隔查询，完成后将 `document` 保存为报告文件，保留引用和链接。

用户提出新的后续问题时，使用 `add_to_thread` 延续任务。`find_threads` 支持按标题搜索和分页。

研究模式包括 Pro 和 Deep。Deep 支持 `literature-review`、`citation-snowballing`、`find-citations`、`verify-citations` 工作流。研究任务还支持附加论文、收藏夹，以及通过完整研究要求管理 Consensus 收藏夹。

## 架构

- **工具目录**：启动时从随包提供的服务器定义注册工具；连接后同步服务器的完整目录和参数。
- **HTTP 客户端**：首次登录或调用工具时加载官方 MCP SDK，直接连接 `https://mcp.consensus.app/mcp`，后续操作复用连接。
- **OAuth 授权**：浏览器完成登录，本机回调接收授权结果，DSH 凭据服务保存并更新登录态。
- **账号页面**：通过 DSH Connection 读取状态、发起登录和退出操作。

## 开发

使用 Node.js 22+ 和 DSH 0.2.2-rc.1。

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run test:ui
```

功能测试使用本机 MCP/OAuth 模拟服务，覆盖五个工具、研究任务流程和账号操作。页面测试使用 Edge 验证登录交互、亮暗主题和移动布局。
