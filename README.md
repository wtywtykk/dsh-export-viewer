# @wtywtykk/dsh-export-viewer

在 DSH Web 界面的会话标题栏加一个按钮：把**当前对话**（含全部子代理会话）导出成一个
**单文件 HTML**，双击即可打开，不需要服务器或任何外部资源。

导出页包含轮次折叠、推理折叠、右侧快速跳转、轨迹视图、总览视图和明暗主题。

## 结构

```
dsh-export-viewer/
├─ index.js           # Host：/api/session.viewer 下载路由
├─ client.js          # Client：会话标题栏按钮（生成中 / 成功 / 失败状态）
├─ viewer-model.js    # Host：把会话事件折叠成页面模型（buildViewer / renderViewerHtml）
├─ assets/            # 页面模板（全部随包内联，不依赖外部文件）
│  ├─ page.html
│  ├─ styles.css
│  ├─ app.js
│  └─ markdown.js
├─ locale/            # 插件管理器的标题/描述（en / zh）
├─ icon.svg
└─ cordis.patch.yml
```

`assets/` 是页面模板的唯一来源：Host 在每次导出请求时读取并内联进 HTML，
修改模板后下一次导出立即生效。

## 行为

- 按钮位于 `conversation.session.header.utilities`（会话标题栏右侧，`...` 与面板按钮之间），
  图标为下载符号，悬停提示“导出对话（HTML）”。
- 点击后 `fetch('api/session.viewer?sessionId=…&includeDescendants=true')`：
  - Host 用 `sessionQuery.readSession` 读取根会话；
  - 用 `sessionQuery.traceSession` 找到全部后代，逐个 `readSession`；
  - 用 `attachments.readImage` 读取会话里出现的全部图片，转成 data URL；
  - 生成模型、内联 `assets/`，以 `dsh-session-<id>.html` 下载。
- 导出期间按钮转圈；成功后短暂显示对勾；失败显示红色感叹号，提示里带错误原因。
- 子代理会出现在导出页左侧的“会话”列表里，按委托深度缩进；主会话里的子代理调用处也有跳转按钮。
- **所有轮次默认折叠**（包括最新一轮）：只显示用户消息、注入提示、折叠行和最终回复；
  推理、工具调用、中间回复要点开折叠行才出现，推理正文还要再点“思考”那一行。
- **图片随页面打包**：用户消息、助手消息和工具结果里的图片都会内联成 data URL，
  在气泡、过程行以及展开后的工具结果里显示（点击在新标签页打开原图）。
- **回答里的 Markdown 图片**（`![alt](path)`）会渲染成图片：本地路径按会话的 `cwd`
  读取并转成 data URL（单页上限 64 MB），`http(s):` / `data:` 原样保留；
  图片路径到 data URL 的映射放在页面数据的 `media` 字段里。
- 不需要任何配置；没有 `Config` 段。

## 安装

通过 DSH 的插件管理器安装本 bundle（bundle 名 `@wtywtykk/dsh-export-viewer`）。
本地开发时，直接把本目录作为 bundle 加入目标 profile 即可。

要求 DSH 0.2.x；会话格式 v0–v4 均可导出。

## 模板定制

`assets/` 下的四个文件就是导出页的全部前端资源（页面、样式、渲染器、Markdown 引擎），
按需修改即可；Host 每次导出都会重新读取，修改后下一次导出立即生效，无需重启或重新加载。

## 限制

- 图片超过单页 64 MB（原始字节）预算时会被跳过，避免导出页失控。
- 普通文件附件不内联，只在消息里保留文本。
- 整个 HTML 在 Host 内存里生成后一次性返回；图片多、子代理多（上百个、总计数百 MB）的会话
  会占用较多内存、下载前有明显等待。
- 聊天视图按原始日志渲染，`surfaceOp: replace` 会把新旧消息都列出来；准确的当前 surface
  以轨迹视图为准。

## 许可证

MIT
