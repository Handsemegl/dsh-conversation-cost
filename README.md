# dsh-conversation-cost

DSH（DeepSeek Harness）Web 插件：在输入框下方显示**当前对话已花掉多少人民币**，点一下展开明细。

## 效果

- 输入框下方统计条里多一个 **¥0.0423** 的读数（紧跟官方的「本轮/用量」统计）。
- **每一轮对话结束时，该轮末尾显示这一轮花了多少**：`本轮费用 ¥0.128 · 27 次请求`，鼠标悬停可看该轮输入/缓存命中/输出 tokens。历史轮次同样显示，翻回去也能看到。
- 点击输入框下方的读数，在输入框上方展开一张卡片：
  - 合计金额；
  - 按模型分行：缓存命中 / 未命中 / 输出 tokens 与对应金额；
  - 请求总数，其中高峰时段与空闲时段各多少次；
  - 最近一次统计时间与「刷新」按钮。
- 每 5 秒自动刷新（页面隐藏时暂停），切换会话自动换成本会话的数据。

## 金额是怎么算的

数据来自会话日志里**模型自己上报的 `usage`**（`assistant/message` 事件的 `inputTokens` / `outputTokens` / `cacheReadTokens`），不是字数估算。价格用 DeepSeek 官方人民币价目表（元 / 百万 tokens）：

| 模型 | 缓存命中（高峰 / 空闲） | 缓存未命中（高峰 / 空闲） | 输出（高峰 / 空闲） |
| --- | --- | --- | --- |
| deepseek-flash | 0.04 / 0.02 | 2 / 1 | 8 / 4 |
| deepseek-v4-pro | 0.30 / 0.15 | 9 / 4.5 | 27 / 13.5 |

- 高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00；其余时间（含周末）按空闲时段半价。
  **中国法定节假日未单独建模**，节假日会被当作工作日计价，因此那几天的高峰时段金额会略偏高。
- 每条请求按它自己的时间戳判定峰谷，所以跨过 12:00 的一轮对话会自动分段计价。
- 价格来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>，价目版本记录在接口返回的 `pricingVersion`。

### 模型怎么自动匹配

每条请求记录里都带着实际调用时的模型 id，插件按下面的顺序自动认价：

1. **官方表精确命中** — `deepseek-flash`、`deepseek-v4-pro`（`match: exact`）。
2. **运行时别名** — `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，按 Flash 计费（`match: alias`）。
3. **已下线模型** — `deepseek-chat`、`deepseek-reasoner`、`deepseek-v3.x` 由 Flash 提供服务（`match: retired`）。
4. **运行时模型目录** — 启动后通过 `llm` 服务读取各 provider 实际提供的模型清单；模型在清单里但价目表没有单价时，标为 `match: catalog` 并视为**估算**。
5. **名称推断** — 名字里含 `flash` / `pro` 时按对应行估算（`match: heuristic`）。
6. **兜底** — 其余全部按 Flash 单价估算（`match: fallback`）。

返回里每个模型都带 `match`（怎么认出来的）和 `rateSource`（单价从哪来）；凡是估算的会在卡片里显示 `≈`，悬停可看具体原因。模型目录会随 `llm/adapters-updated` / `llm/models-updated` 事件和每 5 分钟的定时刷新更新。

### 添加其他提供商的 API 怎么算

计费完全依赖 **provider 在 `usage` 里上报的 token 数**，与提供商无关；缺的只是「这个模型多少钱」。两种做法：

**一、配置单价（推荐）** —— 在 profile 的 `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- patch:
    - id: conversation-cost
      config:
        pricing:
          # 键可以是模型 id
          'gpt-4o': { cacheHit: 18, cacheMiss: 18, output: 72 }
          # 也可以是价目表里的行名（影响所有落到该行的模型）
          'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 }
          # '*' 影响所有"没认出来"的模型
          '*': { cacheHit: 10, cacheMiss: 10, output: 30 }
```

- 单位是**元 / 百万 tokens，且填的是高峰价**；空闲时段自动按半价算，与 DeepSeek 官方规则一致。
- 只填 `cacheMiss` 和 `output` 时，`cacheHit` 默认等于 `cacheMiss`。
- 价格配置是**可回溯的**：插件会保留每条请求的用量，改完价格后重启插件，历史总额会按新单价重算，而不只是影响之后的新请求。
- 配置格式不对（缺字段、负数）不会让插件崩，会写一条 warning 并忽略那一行。

**二、不配置** —— 非 DeepSeek 模型照常统计 token，按 Flash 单价估算，界面用 `≈` 标出，不会把估算当成精确价格。

注意：**跨币种**（美元计价的 OpenAI / Anthropic 等）需要你自己换算成人民币后再填进配置，插件不做汇率换算。

## 查询当前价目表

`GET /api/dsh-conversation-cost/pricing` 返回内置价目表、生效中的配置覆盖项，以及当前运行时识别到的模型列表，用来确认某个模型是精确计价还是估算。

## 只统计「活会话」

费用接口走 Host 的活会话内存（`ctx.sessions.get`），所以：

- 打开的会话、正在运行的会话：正常显示金额；
- 还没打开的旧会话：显示 `¥—`，打开后立即恢复。

这样不需要解压 / 解析磁盘上的会话文件，也不会有多帧压缩日志的兼容问题。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-conversation-cost/session?sessionId=<id>` | 该会话累计的人民币费用、按模型明细与按轮次明细 |

返回里的 `turns` 是每一轮的 `{ turn, startSeq, endSeq, requests, cost, … }`：`startSeq`/`endSeq` 是该轮 `turn/start` → `turn/end` 的事件序号，聊天界面用它把「本轮费用」放到对应的那一轮末尾。没有上报用量的轮次不出现在 `turns` 里，各行 `cost` 之和恒等于 `totalCost`。

仅接受本机回环地址的同源请求；未知会话返回 `404 { ok: false, reason: 'not-live' }`，缺参数返回 400。

## 文件结构

```
lib/index.js        Host 半区：只读路由 + 日志折叠 + 人民币价目表（零依赖）
lib/client.js       浏览器半区：¥ 读数 + 明细卡片 + 每轮费用（零构建，loader factory 格式）
cordis.patch.yml    bundle 挂载声明
locale/zh.json      插件管理器里显示的中文标题与描述
locale/en.json      English title and description
icon.svg            插件图标
scripts/check.mjs   离线校验：Host 路由折叠 / 峰谷计价 / Client 装配
```

## 安装

```sh
dsh plugin --profile <name> add file:C:/path/to/dsh-conversation-cost
```

或在 DSH 的「设置 → 插件」里安装本目录。装完刷新页面即可看到读数。

## 开发

```sh
node --check lib/index.js
node --check lib/client.js
node scripts/check.mjs
```

改 `lib/client.js`：刷新页面即生效。
改 `lib/index.js`（Host 半区）：需要重启该插件条目才会重新加载模块 —— 在「设置 → 插件」里关掉再打开 `dsh-conversation-cost`（或重启 DSH）。插件管理器里关/开一次即可，不必重启整个应用。

`scripts/check.mjs` 用假 Session 驱动真实的路由处理函数，断言：

- 空闲时段：100 万输入（60 万缓存命中）+ 100 万输出 = **¥4.412**；
- 高峰时段同一份用量 = **¥8.824**；
- 两轮对话按 `turn/start`/`turn/end` 分段计价，序号区间与金额正确，且各轮之和等于总额；
- 重复读取不重复计数；未知模型回退 Flash 单价并打标记；
- 缺失会话 404、缺参数 400；
- Client 侧三个插槽（`conversation.composer.dock` / `conversation.input.dock` / `conversation.chat.turnTail`）都已注册；
- 「本轮费用」的定位：优先按 `TurnLocation` 的轮次号，其次按关闭序号所在区间、区间后一位、以及最新一轮兜底；轮次之前的序号不会误挂。

## 卸载

```sh
dsh plugin --profile <name> remove dsh-conversation-cost
```

## License

MIT
