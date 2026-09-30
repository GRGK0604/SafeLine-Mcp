# SafeLine MCP Server

基于仓库中的 Swagger 2.0 文档（doc.json）开发的 MCP Server。它索引全部 227 个 API 操作，支持检索、查看参数和受控调用，不依赖手写接口清单。仅提供带 Bearer 鉴权的 Streamable HTTP 接口。

## 安装

需要 Node.js 20 或更新版本。进入本目录后执行：

    npm install

先复制示例配置并填写实际的管理地址与 API Token：

    cp config.example.json config.json
    chmod 600 config.json

默认从项目根目录的 config.json 读取配置，与运行时的工作目录无关。当前工作区已放置配置文件；其中的两个 Token 分别用于访问 SafeLine 和访问 MCP，不能混用。配置内容示例：

    {
      "baseUrl": "https://127.0.0.1:9443",
      "token": "YOUR_TOKEN",
      "tokenHeader": "X-SLCE-API-TOKEN",
      "allowMutations": false,
      "allowSensitive": false,
      "insecureTls": false,
      "timeoutMs": 15000,
      "mcpAuthToken": "",
      "mcpPort": 3000
    }

直接启动可用 npm start；指定其他配置文件可用 npm start -- --config /path/to/config.json。服务仅提供 http://127.0.0.1:3000/mcp（端口可用 mcpPort 修改）。在支持 Streamable HTTP 的 MCP 客户端中填写该 URL，并设置 Authorization: Bearer <mcpAuthToken> 请求头；不再支持将本服务作为 stdio MCP 子进程接入。

例如支持 URL 和自定义请求头的客户端可配置为：

    {
      "mcpServers": {
        "safeline": {
          "url": "http://127.0.0.1:3000/mcp",
          "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
        }
      }
    }

Token 只从配置文件读取；config.json 已加入 .gitignore，不要把真实 Token 写进提交的文件。下游 SafeLine API 默认请求头为 X-SLCE-API-TOKEN，可修改 tokenHeader。

## Streamable HTTP 鉴权

运行 npm start，MCP 客户端每次请求都必须携带 Authorization: Bearer <mcpAuthToken>；缺失或错误返回 HTTP 401。mcpAuthToken 是独立于下游 SafeLine token 的随机密钥，至少 32 个字符，当前私有 config.json 已自动生成。新部署可在本机运行以下命令生成并填入 config.json：

    node -p "require('node:crypto').randomBytes(32).toString('base64url')"

请只通过可信的本机客户端配置传递该值，不要写入对话或版本库。

服务不提供 OAuth 登录流程；需要跨机器访问时，请在前面部署 HTTPS 反向代理，并保留鉴权。HTTP 入口是唯一的 MCP 传输方式；没有独立 SSE 或 stdio 端点。

## MCP 工具

- connection_status：显示配置状态，不联网也不暴露 Token。
- list_operations：按 search、tag、method 分页搜索操作；返回精确操作键。
- describe_operation：查看单个操作的路径、参数和请求体结构。
- call_operation：用精确操作键调用 API，支持 pathParams、query、body。

调用示例：

    {"operation":"GET /open/site"}

请以 list_operations 返回的键为准。默认只允许 GET。若需要 POST/PUT/DELETE 等写操作，把 allowMutations 设为 true；访问名称含 token/secret/csrf 或响应结构包含凭据字段的操作，还须把 allowSensitive 设为 true。建议使用最小权限的 SafeLine API Token。

## 手动发送 MCP 请求

向 http://127.0.0.1:3000/mcp 发 POST，请求头设置 Authorization: Bearer <config.json 中的 mcpAuthToken>、Content-Type: application/json、Accept: application/json, text/event-stream。这里使用的是 MCP 鉴权密钥，不是下游 SafeLine 的 token；后者由服务端自动加入 X-SLCE-API-TOKEN 请求头。

第一次请求发送 initialize：

    {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-client","version":"1.0.0"}}}

随后发送初始化通知；从这一步起，所有 POST 请求都额外携带 MCP-Protocol-Version: 2025-06-18：

    {"jsonrpc":"2.0","method":"notifications/initialized"}

最后调用工具，例如读取站点列表：

    {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"call_operation","arguments":{"operation":"GET /open/site"}}}

initialize 和 tools/call 的响应可能是 text/event-stream；此时读取 SSE 事件中的 data 字段即可得到 JSON-RPC 结果。初始化通知成功时返回 HTTP 202。标准 MCP 客户端会自动完成这些协议步骤。

## 网络安全

- 默认验证 TLS 证书。如需忽略证书验证，可把 insecureTls 设为 true；此时仍使用 HTTPS，但无法验证服务端身份，仅建议在受信任的测试环境中使用。
- 远程地址必须是 HTTPS；HTTP 仅允许 localhost、127.0.0.1 或 ::1，且不跟随重定向。
- 默认超时 15 秒，可通过 timeoutMs 调整；请求体与响应体各限制为 1 MiB。
- HTTP 服务固定只监听 127.0.0.1，避免直接在公网暴露明文 Bearer Token；同时校验 Host 和 Origin。

运行 npm test 执行单元和 Streamable HTTP 协议测试。没有真实 SafeLine 实例也能运行这些测试；实际管理 API 是否可用还取决于你配置的实例、Token 权限和版本。
