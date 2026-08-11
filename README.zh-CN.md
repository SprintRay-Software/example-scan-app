# SprintRay 桌面扫描仪集成 — 示例应用

[English](./README.md) | 中文

一个**桌面应用侧**的参考实现与**示例应用**,对应 SprintRay 的 device-login + 扫描文件上传集成。
用它理解整个流程,并在把逻辑接入你真实的桌面扫描仪应用之前完成端到端联调。

它在**同一套完整埋点的流程**(`src/core/`)之上提供两个前端:

- **桌面 UI(Electron)** —— `npm run app` —— 展示解析出的启动 payload、逐步骤的实时流水线,以及
  **每一次 HTTP 请求的完整 request 与 response**,让测试者能观测到完整的数据流(见
  [桌面 UI](#桌面-uielectron));
- **命令行运行器** —— `npm start` —— 同一套流程,输出到控制台。

两个前端还都会提供 **`127.0.0.1` 上的本机 HTTP 服务** —— 除 URL scheme 之外,Web 端触达桌面扫描仪的
第二条路径(见[本机 HTTP 服务](#本机-http-服务127001))。

命令行及其核心为**零依赖**(仅 Node.js ≥ 18 内置能力);Electron 仅作为可选的 `devDependency`,只在
运行 UI 时才需要。

## 集成流程

从你的桌面应用视角,共四步 —— **无浏览器、无需重新登录,且 token 绝不出现在启动 URL 中**:

1. **拉起。** 在 treatment 页面,SprintRay Web 端通过你注册的自定义 URL scheme 拉起你的应用,
   并带上一段 base64 编码的 JSON —— `yourscheme://<base64_json>` —— 其中只含一个**一次性、短时效的 `code`**。
   (同一份 payload 也可以改为经[本机 HTTP 服务](#本机-http-服务127001)送达,前提是你的应用运行了该服务。)
2. **解码。** 对 payload 做 base64 解码,读取 `code`、token 接口路径,以及 treatment / case 标识
   (见[启动 payload](#启动-payload))。
3. **换取 token。** 通过 HTTPS 把 `code` + 你的客户端凭据 POST 上去,换取已登录医生的 `access_token`。
4. **上传。** 为本次请求的扫描文件(启动 payload 中的 `fileType` —— 每次拉起只传一个文件)申请预签名上传 URL,再把文件字节 PUT 上去。扫描文件会自动挂到 treatment 上。

### 流程

```mermaid
sequenceDiagram
    actor Doctor
    participant Web as SprintRay Web App
    participant App as Your Desktop App
    participant BE as SprintRay Backend
    participant S3 as S3 (presigned)

    Doctor->>Web: 点击扫描
    Web->>BE: 申请 device-login code
    BE-->>Web: code + scanJobId + tokenEndpoint 路径
    Web->>App: 打开自定义 URL scheme（内含 code，不含 token）
    activate App
    App->>App: base64 解码 payload，读取 code + tokenEndpoint
    App->>BE: 用 code + 客户端凭据换取 token
    BE-->>App: access_token + expires_in
    App->>BE: 为请求的扫描文件（上颌或下颌）申请预签名上传 URL
    BE-->>App: 预签名上传 URL
    App->>S3: PUT 原始文件字节
    S3-->>App: 200 / 204
    deactivate App
    Note over Doctor,S3: 扫描文件挂载到 treatment
```

### 启动 payload

```json
{
  "caller": { "name": "SprintRay", "version": "1.0.10.0" },
  "case": { "name": "<患者姓名>", "ID": "<scan-job id>" },
  "treatment": {
    "teeth": [
      { "teeth": 3, "notes": "", "toothApplianceType": 3, "groupNumber": null }
    ]
  },
  "fileType": null,
  "language": "en_US",
  "serverType": 0,
  "toothSystem": "fdi",
  "auth": {
    "code": "<one-time-code>",
    "tokenEndpoint": "/api/integration/device-login-token",
    "expiresIn": 600
  },
  "treatmentId": "<treatment id>",
  "externalCaseId": "<external case id>"
}
```

| 字段 | 用途 |
|---|---|
| `caller` | 拉起方(`SprintRay` + Web 端版本) |
| `case.name` | 患者显示名 |
| `case.ID` | 本次拉起的 scan-job 标识 |
| `treatment.teeth[]` | 选中的牙位 —— `teeth`(牙号)、`notes`、`toothApplianceType`、`groupNumber` |
| `fileType` | 请求的文件类型(`TreatmentFiles`;见 [枚举](#枚举)),整口扫描时为 `null` |
| `language` | 界面语言,如 `en_US` |
| `serverType` | 服务器类型标识 |
| `toothSystem` | 牙位编号系统:`fdi` 或 `utn` |
| `auth.code` | 用于换取 token 的一次性 device-login code |
| `auth.tokenEndpoint` | token 接口**路径** —— 拼接到后端 origin 之后 |
| `auth.expiresIn` | code 有效期(秒) |
| `treatmentId` | 上传的扫描文件要挂载到的 treatment |
| `externalCaseId` | 外部 case id(上传时作为 `externalCaseId` 传回) |

> `auth`、`treatmentId`、`externalCaseId` 是 SprintRay 的静默鉴权与上传上下文;
> 其余为标准 ScanPro 启动 payload。

## 接口约定

共两个调用。`{ORIGIN}` 为对应环境下固定的 SprintRay 后端 origin(不带 `/api` 后缀,路径本身已含 `/api`):

| 环境 | `{ORIGIN}` |
|---|---|
| 生产 | `https://dashboard.sprintray.com` |

对应环境的 origin 由 SprintRay 提供。

### 1. 用 code 换取 token

```http
POST {ORIGIN}{auth.tokenEndpoint}
Content-Type: application/json

{ "code": "<code>", "clientId": "<your-client-id>", "clientSecret": "<your-client-secret>" }
```

`200 → { "access_token": "…", "token_type": "Bearer", "expires_in": 86400 }`

错误:`400` code 缺失/过期/已使用 · `401` 客户端凭据错误。token 过期后,重新拉起以获取新 token。

### 2. 申请预签名上传 URL,再 PUT 文件

```http
POST {ORIGIN}/api/file/upload
Authorization: Bearer <access_token>
Content-Type: application/json

{ "fileName": "upper.stl", "fileSize": 3083734, "treatmentId": "<treatment-id>",
  "treatmentFileType": 1, "externalCaseId": "<external-case-id>" }
```

`200 →` 一个预签名上传 URL(JSON 字符串,或 `{ "url": "…" }`)

```http
PUT <presignedUrl>
Content-Type: application/octet-stream
Content-Length: <fileSize>

<原始文件字节>
```

成功返回 `200`/`204`。PUT 请求**不带**鉴权头 —— 预签名 URL 自带授权。

- `treatmentFileType`:**`1` = 上颌,`2` = 下颌**。示例应用**每次拉起只上传一个文件**,由启动 payload 中的
  `fileType` 决定:`2` → `lower.stl`,其它(或未提供 `fileType`)→ `upper.stl`。日志中会打印所用的取值及其来源。
- 扫描文件为 **STL** 格式。

## 枚举

payload 与上传调用中用到的数值枚举。

### `treatmentFileType` / `fileType` —— `TreatmentFiles`

上传时作为 `treatmentFileType` 发送,在启动 payload 中作为 `fileType` 收到。口内扫描只需:

| 值 | 名称 |
|---|---|
| `1` | UpperJaw(上颌) |
| `2` | LowerJaw(下颌) |

<details>
<summary>全部 <code>TreatmentFiles</code> 取值</summary>

| 值 | 名称 |
|---|---|
| 1 | UpperJaw |
| 2 | LowerJaw |
| 3 | LeftSide |
| 4 | RightSide |
| 5 | Other |
| 6 | Spr |
| 7 | SingleStl |
| 8 | DesignPhoto |
| 9 | CBCT |
| 10 | SingleStlWithSupports |
| 11 | BaseStl |
| 12 | BaseSpr |
| 13 | PonticStl |
| 14 | PonticSpr |
| 15 | PatientPhoto |
| 16 | SurgicalGuideStl |
| 17 | SurgicalGuideSpr |
| 18 | CementedRestorationStl |
| 19 | CementedRestorationSpr |
| 20 | RemovableDieStl |
| 21 | RemovableDieSpr |
| 22 | CustomBleachingTrayStl |
| 23 | CustomBleachingTraySpr |
| 24 | WaxUpUpperStl |
| 25 | TrialSmileUpperStl |
| 26 | WaxUpSpr |
| 27 | TrialSmileSpr |
| 28 | DesignVideo |
| 29 | MonolithicTryInDentureStl |
| 30 | MonolithicTryInDentureSpr |
| 31 | DentureGumBaseStl |
| 32 | DentureGumBaseSpr |
| 33 | DentureTeethStl |
| 34 | DentureTeethSpr |
| 35 | WaxUpLowerStl |
| 36 | TrialSmileLowerStl |
| 37 | CephXRayPhoto |
| 38 | PanoXRayPhoto |
| 39 | FrontFace |
| 40 | FrontSmile |
| 41 | RightSideFace |
| 42 | LeftSideFace |
| 43 | FrontTeeth |
| 44 | RightSideTeeth |
| 45 | LeftSideTeeth |
| 46 | UpperJawImage |
| 47 | LowerJawImage |
| 48 | PreppedToothIntraoralScans |
| 49 | DentureWaxSetup |
| 50 | UpperTissueScan |
| 51 | LowerTissueScan |
| 52 | PhotogrammetryData |
| 53 | MonolithicHybridDenturesStl |
| 54 | MonolithicHybridDenturesSpr |
| 55 | AICrownPreviewImage |
| 56 | AICrownStl |
| 57 | AICrownDieStl |
| 58 | BiteScanCombo |
| 59 | DentureUpperStl |
| 60 | DentureLowerStl |
| 61 | SmileDesignStl |
| 63 | SmileDesignFrontSmile |
| 64 | UpperJawRetainer |
| 65 | LowerJawRetainer |
| 66 | UpperJawAligner |
| 67 | LowerJawAligner |
| 68 | SprRetainer |
| 69 | SprAligner |
| 70 | UpperAppliance |
| 71 | LowerAppliance |
| 72 | UpperAntagonist |
| 73 | LowerAntagonist |
| 74 | VeneersDesignFrontSmile |
| 75 | VeneersStl |
| 76 | VeneersSpr |
| 77 | PreppedUpperJaw |
| 78 | PreppedLowerJaw |
| 79 | DentalModelDieStl |
| 80 | Link |
| 81 | ImplantCrownStl |
| 82 | ImplantShellTempStl |
| 83 | ImplantBridgeStl |
| 84 | UpperDirectPrintAppliance |
| 85 | LowerDirectPrintAppliance |
| 86 | UpperDirectPrintTemplate |
| 87 | LowerDirectPrintTemplate |
| 88 | SingleStlOnlyView |
| 89 | UpperJawOnlyViewStl |
| 90 | LowerJawOnlyViewStl |
| 91 | TrackingLink |
| 92 | PartialDentureBaseStl |
| 93 | PartialDentureBaseSpr |
| 94 | TreatmentTeethImage |
| 95 | AISmilePreviewImage |
| 96 | AISmilePreviewVideo |
| 97 | PreOpUpperJaw |
| 98 | PreOpLowerJaw |
| 99 | CorrectedUpperJaw |
| 100 | CorrectedLowerJaw |
| 101 | Profile45Degree |
| 102 | UpperScanbodyScan |
| 103 | LowerScanbodyScan |

`62` 未使用。

</details>

### `treatment.teeth[].toothApplianceType` —— `ToothApplianceType`

| 值 | 名称 |
|---|---|
| 1 | PonticSites |
| 2 | Clasps |
| 3 | Crown |
| 4 | SplintCrown |
| 5 | Splint |
| 6 | Inlay |
| 7 | Onlay |
| 8 | ShellTemp |
| 9 | Wings |
| 10 | Base |
| 11 | Extraction |

### `toothSystem`

由医生的牙位编号偏好(`DentalNotation`)映射而来的字符串:

| `toothSystem` | 含义 |
|---|---|
| `utn` | 通用牙位编号 Universal Tooth Numbering(`DentalNotation.Utn` = 1)—— 默认 |
| `fdi` | FDI 世界牙科联盟编号(`DentalNotation.Fdi` = 2) |

### `serverType`

目前没有为其定义枚举,始终为固定值 `0`。

## 你需要向 SprintRay 索取的信息

| 值 | 环境变量 | 说明 |
|---|---|---|
| 后端 origin | `SCANPRO_BASE_URL` | 按环境固定(dev / staging / prod,见上表);不带 `/api` 后缀 |
| Client ID | `SCANPRO_CLIENT_ID` | 你集成的公开 id |
| Client Secret | `SCANPRO_CLIENT_SECRET` | 仅保存在服务端 / 你的应用内 |
| URL scheme | `SCANPRO_URL_SCHEME` | 你的应用注册的 scheme,如 `openScanPro` |
| 遥测接口地址 | `SCANPRO_TELEMETRY_URL` | 仅用于端口耗尽事件;按环境下发 |
| 遥测 API key | `SCANPRO_TELEMETRY_API_KEY` | 遥测接口唯一的凭据 |

## 运行示例应用

前置条件:Node.js ≥ 18(`--env-file` 需 ≥ 20.6)。支持 macOS / Windows / Linux(scheme 注册以 macOS 为已验证路径)。

```sh
cp .env.example .env      # 填入 origin、client id/secret、scheme
```

## 桌面 UI(Electron)

推荐用于联调的方式。它运行与命令行完全相同的流程,但以可视化方式呈现,便于观测每个步骤并检查
网络上传输的每一个字节。

```sh
npm install               # 会安装 Electron(devDependency)
npm run app               # 启动桌面 UI
```

窗口分三块:

- **左侧 —— 配置与输入。** 后端 origin、client id/secret、URL scheme 会从 `.env` 预填(可按次修改)。
  粘贴 `openScanPro://<base64>` **启动 URL**,或切到 **Manual code** 用显式 `code` + treatment id 运行;
  还可选择自定义扫描文件、勾选是否额外走 token 刷新步骤。
- **右侧 —— 观测区。**
  - **Pipeline** —— 桌面应用侧的步骤按序展示(解析 → 换 token → 可选刷新 → 预签名 URL → S3 PUT),
    每步显示实时状态与一行摘要。
  - **Decoded launch payload** —— 解析出的字段(`code`、`tokenEndpoint`、`treatmentId`、
    `externalCaseId`、`fileType`)以及完整的解码 JSON;**Decode payload** 可在不发起网络请求的情况下预览。
  - **HTTP transactions** —— 每次调用一张可展开的卡片,包含**完整 request**(method、URL、headers、body)
    与**完整 response**(status、headers、body、耗时);body 会格式化并可复制,S3 PUT 的 body 显示为
    `<binary N bytes>`。
  - **Log** —— 与命令行一致的带时间戳 step/ok/fail/info 流。

**从浏览器拉起。** 应用会把自身注册为该 URL scheme 的系统处理器(`app.setAsDefaultProtocolClient`),
因此在 SprintRay 网页点击 **OR Scan** 可直接拉起它 —— 深链会落入启动 URL 输入框并自动解析。右上角
**Claim handler** 按钮可重新抢占 scheme;macOS 上打包后的构建更可靠,开发期直接粘贴启动 URL 最稳妥。

### 注册 URL scheme(真实的系统拉起)

让操作系统把 `yourscheme://…` 路由到本示例应用,这样在浏览器里点击拉起入口即可真实启动它:

```sh
npm run register      # 向操作系统注册 scheme
npm run status        # 查看该 scheme 当前解析到哪里
npm run unregister    # 移除
```

- **macOS**:会在 `~/Applications` 下创建一个 app;首次拉起会请求"控制 Terminal"(用于展示运行过程)
  —— 点 **OK**,或用 `npm run register -- --headless` 改为输出到日志文件。改动代码或 `.env` 后需重新 `register`。
- **Windows / Linux**:注册为当前用户级处理器(注册表 / `.desktop`)。

### 直接对启动 URL 运行

```sh
# 形式 A —— 浏览器交过来的深链
node --env-file=.env src/index.js "yourscheme://<base64_json>"

# 形式 B —— 显式传入 code(无启动 URL)
node --env-file=.env src/index.js --code <code> --base-url <origin> --treatment-id <guid>
```

追加 `--demo-refresh` 可一并演示 token 刷新接口。

### 它做了什么

每次运行会:换取 token,然后上传**单个**扫描文件 —— 当启动 payload 的 `fileType` 为 `2`(下颌)时上传
`fixtures/lower.stl`,否则上传 `fixtures/upper.stl` —— 并展示实时进度条。
**每个后端请求与响应都会被完整打印**(方法、URL、请求头、请求体 / 状态码、响应头、响应体),
让你清楚地看到该发送什么、该期望什么。把 `fixtures/` 里的文件替换成你自己的扫描件即可测试其它数据。

## 本机 HTTP 服务(`127.0.0.1`)

Web 端触达桌面应用的**第二条路径**。不走系统 URL scheme,而是由浏览器在回环地址上探测一个固定端口
区间,找到常驻服务后把 payload POST 过去。两条路径携带的是**同一份** base64 JSON payload,在本示例
应用里也都落到同一个窗口。

本应用实现了该契约的服务端,你可以把 Web 端直接指过来,看到调用方真实看到的一切 —— 尤其是 CORS 行为,
浏览器访问回环地址的集成通常就断在这里。

桌面 UI 启动时会自动拉起该服务,右上角 **server** 芯片显示它占用的端口(悬停可看接口列表)。
不带 Electron 单独运行:

```sh
npm run serve                  # 占用端口,提供 /status 与 /start
npm run serve -- --run-flow    # 并且在 /start 时真正换取 token 并上传扫描文件
npm run serve -- --help        # 全部选项:端口区间、上报的版本/状态、Host 校验开关
```

### 服务发现

**没有固定端口** —— 服务取第一个能监听成功的端口,因此调用方必须探测。两侧必须对齐同一个区间:

| | |
|---|---|
| 端口区间 | `29083`–`29183`(含),共 101 个 |
| 选取方式 | 启动时从 `29083` 起逐个尝试,第一个能监听的即为所用 |
| 监听地址 | 仅 `127.0.0.1`,不监听外部网卡 |
| 区间耗尽 | **不启动** HTTP Server,改为上报遥测(见下) |

**调用方的探测约定:** 从 `29083` 起逐个端口调用 `GET /scanpro/v1/status`,第一个返回 `200` 且响应体中
`"service": "SprintRayScanService"` 的端口即为本服务。命中后**缓存该端口**并复用,仅在请求失败时重新探测。

> 用 `service` 判定很重要。只凭响应里有没有 `version` 字段,无法把本服务和恰好占用该端口的其它程序区分开。

### `GET /scanpro/v1/status`

安装状态、运行状态与版本一次返回,不需要分两次探测。

```console
$ curl -s http://127.0.0.1:29083/scanpro/v1/status
{"service":"SprintRayScanService","running":true,"installed":true,"version":"0.2.0"}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `service` | string | 恒为 `SprintRayScanService` —— 服务发现的判据 |
| `running` | bool | ScanPro 正在运行 |
| `installed` | bool | ScanPro 已安装 |
| `version` | string | ScanPro 版本号 |

### `POST /scanpro/v1/start`

用一份启动 payload 拉起 ScanPro。**这是同步阻塞接口** —— 请求会一直挂起到启动成功或失败为止,请设置足够
长的超时;并且超时后**不要**直接重试,先用 `/status` 确认 ScanPro 是不是其实已经起来了。

`argument` 是 **Base64 编码后的 JSON** 启动 payload —— 和 URL scheme 携带的是同一份。必填,且不能为空字符串。

```sh
ARGUMENT=$(node -e 'console.log(Buffer.from(JSON.stringify({
  caller: { name: "SprintRay", version: "1.0.10.0" },
  case:   { name: "Jane Doe", ID: "04024e3b-ff28-4d6a-bdea-4c777e4cfb0d" },
  language: "en_US", serverType: 0, toothSystem: "fdi",
  treatment: { teeth: [{ number: "17", workType: "Crown" }] }
})).toString("base64"))')

curl -s -X POST http://127.0.0.1:29083/scanpro/v1/start \
  -H 'Content-Type: application/json' \
  -d "{\"argument\":\"$ARGUMENT\"}"
```

```json
{ "status": true, "started": true }
```

`status` 是契约当前定义的字段;`started` 是同一个值的更清晰命名,两者一起返回,按哪个读都行。启动失败时
会额外带上 `errorCode` 与 `message`。

如果 payload 里同时带了 SprintRay 的 `auth` 块,这就是一次完整的启动:桌面 UI 会把窗口切到前台并展示解码
后的 payload;`serve --run-flow` 下,示例应用会先换取 token、上传扫描文件,再返回这个请求。

### 错误

`200` 只代表**请求被正确处理**,不代表业务成功 —— "ScanPro 未安装"同样是 `200`,由 `installed: false`
表达。真正的错误用状态码 + 固定信封表达:

```json
{ "error": { "code": "ARGUMENT_REQUIRED", "message": "`argument` is required and must be a non-empty string" } }
```

| 状态码 | `code` | 触发条件 |
|---|---|---|
| `400` | `INVALID_JSON` | 请求体不是合法 JSON |
| `400` | `ARGUMENT_REQUIRED` | `argument` 缺失、不是字符串,或为空 |
| `400` | `ARGUMENT_NOT_BASE64_JSON` | `argument` 解不出 JSON 对象 |
| `403` | `HOST_NOT_ALLOWED` | `Host` 头不是回环名称(见下) |
| `404` | `NOT_FOUND` | 路径不存在 |
| `405` | `METHOD_NOT_ALLOWED` | 路径对、方法不对 |
| `413` | `PAYLOAD_TOO_LARGE` | 请求体超过 256 KB |
| `500` | `START_ERROR` / `STATUS_ERROR` | 服务自身出错 |

`code` 是稳定常量 —— 请对它做分支,不要对 `message` 做分支。

### CORS 与 Chrome 的 Private Network Access

调用方是 HTTPS 页面访问 `http://127.0.0.1`,属于跨源。缺了正确的响应头,请求即使成功,浏览器也会把响应
丢掉。因此本服务:

- 把请求的 `Origin` 回显到 `Access-Control-Allow-Origin`,并始终返回 `Vary: Origin`;
- 对 `OPTIONS` 预检返回允许的方法与请求头;
- 对带 `Access-Control-Request-Private-Network: true` 的预检返回
  `Access-Control-Allow-Private-Network: true` —— **缺这一条 Chrome 会直接拦掉**。

默认回显任意 Origin,这样最便于联调。把 `SCANPRO_LOCAL_SERVER_ORIGINS` 设为逗号分隔的列表即可改成白名单,
名单外的来源拿不到 `Access-Control-Allow-Origin`,浏览器会拦截。

本服务无鉴权,安全性完全依赖"只能从回环访问"。而这个前提只在请求确实是发往回环时才成立,所以 `Host` 头
为其它名称的请求 —— 也就是 DNS rebinding 攻击的形态 —— 会被 `403` 拒绝。调试代理时可用 `--allow-any-host`
关掉该校验。

### 端口区间被占满时

101 个端口全被占用时服务不会启动,Web 端探测不到任何端口,在医生看来就只是"点击扫描没反应"。这台机器上
没有任何人会察觉,所以必须由服务自己上报:

| | |
|---|---|
| `eventName` | `local_server.port_unavailable` |
| `severity` | `error` |
| `eventData` | `{ portRangeStart, portRangeEnd, attempted, lastErrorCode }` |

批次中 `app.name` 填 `ScanPro`,不带 `userId`(服务在任何人登录之前就已启动,填占位值比不填更糟),
也不带 `scanner`。只有同时配置了 `SCANPRO_TELEMETRY_URL` 与 `SCANPRO_TELEMETRY_API_KEY` 才会发送,
否则只记本地日志。`deviceId` 是操作系统机器标识的 SHA-256,`installationId` 生成一次后落盘,
两者都存放在 `~/.sprintray-scanpro-example/`(打包版则在应用的用户数据目录)。

### 相对文档契约的增补

四处增补,均向后兼容 —— 客户端忽略它们也能正常工作:

| 增补 | 原因 |
|---|---|
| `/status` 增加 `service` | 端口探测时,仅凭 `version` 无法确认这是不是本服务 |
| 4xx/5xx 统一为 `{ error: { code, message } }` | 契约只定义了成功响应;`code` 是稳定常量,不是本地化文案 |
| `status` 之外并列返回 `started` | `/status` 用的是语义化命名(`running` / `installed`),`/start` 返回泛化的 `status` 读起来不一致 |
| 回环 `Host` 校验 | 否则一个无鉴权的回环服务会信任任何解析到 `127.0.0.1` 的域名 |

有一处行为是刻意不同的:真实服务会把 `argument` 原样交给 ScanPro,而本服务会解码它,解不开就直接返回
`400`。这正是模拟器的价值 —— 让你在这里就发现 payload 有问题,而不是盯着一个毫无反应的扫描仪。

## 退出码

- `0` —— 换取 token 且全部上传成功(或 register/status/unregister 命令完成)
- `1` —— 参数错误、缺少环境变量、换取 token / 上传失败,或 `serve` 找不到可用端口

## 各 TreatmentType 的提交上传文件

医生**提交** treatment 时需要上传的文件，导出自 DS 生产库（`TreatmentType` ⨝ `TreatmentTypeFile`，`FileKind = 0` = `Original`）。仅含启用（active）的文件；已排除 `Not Selected` 占位类型与所有 `Studio *` 类型。`Type` 为 `TreatmentFiles` 枚举（值 + 名称）；`上限 MB` 为空表示无显式上限。

| 治疗类型 (TreatmentType) | 标题 (Title) | 类型 (TreatmentFiles) | 必填 | 允许格式 (Accept) | 上限 MB |
|---|---|---|---|---|---|
| AI Night Guard | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply | 1024 |
| AI Night Guard | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply | 1024 |
| AI Restorations | Upper Prepped Scan | 77 (PreppedUpperJaw) | Yes | .stl | 1024 |
| AI Restorations | Lower Prepped Scan | 78 (PreppedLowerJaw) | Yes | .stl | 1024 |
| AI Retainer | Upper Scan | 1 (UpperJaw) | No | .stl,.ply | 1024 |
| AI Retainer | Lower Scan | 2 (LowerJaw) | No | .stl,.ply | 1024 |
| AI Sports Guard | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply | 1024 |
| AI Sports Guard | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply | 1024 |
| Bleaching Tray Models | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Bleaching Tray Models | Supporting Images | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 100 |
| Bleaching Tray Models | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Bonded Restorations | Upper Scan | 77 (PreppedUpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Bonded Restorations | Supporting Images | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 100 |
| Bonded Restorations | Upper Scan | 97 (PreOpUpperJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Bonded Restorations | Lower Scan | 78 (PreppedLowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Bonded Restorations | Lower Scan | 98 (PreOpLowerJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Bonded Restorations | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Bracket Removal | Maxillary scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Bracket Removal | Supporting Images | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 100 |
| Bracket Removal | Mandibular scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Clear Aligners | Maxillary scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Clear Aligners | PANO X-ray | 38 (PanoXRayPhoto) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Front Face | 39 (FrontFace) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Front Smile | 40 (FrontSmile) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Right Side Face | 41 (RightSideFace) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Left Side Face | 42 (LeftSideFace) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Upper Jaw | 46 (UpperJawImage) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Lower Jaw | 47 (LowerJawImage) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Front Teeth | 43 (FrontTeeth) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Right Side Teeth | 44 (RightSideTeeth) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Left Side Teeth | 45 (LeftSideTeeth) | Yes | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Mandibular scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Clear Aligners | CEPH X-ray | 37 (CephXRayPhoto) | No | .jpeg,.jpg,.png | 1024 |
| Clear Aligners | Bite Scan | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Definitive Crown | Maxillary scan | 1 (UpperJaw) | Yes | .stl | 1024 |
| Definitive Crown | Left side | 3 (LeftSide) | No | .stl | 1024 |
| Definitive Crown | Supporting Images | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 1024 |
| Definitive Crown | Mandibular scan | 2 (LowerJaw) | Yes | .stl | 1024 |
| Definitive Crown | Right side | 4 (RightSide) | No | .stl | 1024 |
| Dental Model | Upper Scan | 1 (UpperJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Dental Model | Lower Scan | 2 (LowerJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Dental Model | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Full Dentures | Upper Scan | 1 (UpperJaw) | Yes | .stl,.zip | 300 |
| Full Dentures | Upload any additional images. | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 100 |
| Full Dentures | Upper Wax Rim Scan | 24 (WaxUpUpperStl) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Full Dentures | Lower Wax Rim Scan | 35 (WaxUpLowerStl) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Full Dentures | Lower Scan | 2 (LowerJaw) | Yes | .stl,.zip | 300 |
| Full Dentures | Upper Denture Scan | 59 (DentureUpperStl) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Full Dentures | Lower Denture Scan | 60 (DentureLowerStl) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Full Dentures | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Upper Jaw | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Upper Tissue Scan | 50 (UpperTissueScan) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Patient Records or Files | 52 (PhotogrammetryData) | No | .zip | 1024 |
| Hybrid Dentures | Upper Appliance Scan | 70 (UpperAppliance) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Upper Antagonist | 72 (UpperAntagonist) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Lower Jaw | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Lower Tissue Scan | 51 (LowerTissueScan) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Upload Pictures Of Patient Smiling | 15 (PatientPhoto) | No | .jpeg,.jpg,.png | 1024 |
| Hybrid Dentures | Bite Scan | 58 (BiteScanCombo) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Lower Appliance Scan | 71 (LowerAppliance) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Hybrid Dentures | Lower Antagonist | 73 (LowerAntagonist) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Implant Planning and Surgical Guide | Upper Scan | 1 (UpperJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Implant Planning and Surgical Guide | Upload full .ZIP file | 9 (CBCT) | Yes | .dicom,.zip | 1024 |
| Implant Planning and Surgical Guide | Upload any additional images | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 100 |
| Implant Planning and Surgical Guide | Denture/Wax Setup Scan | 49 (DentureWaxSetup) | No | .stl,.ply,.obj,.dcm | 1024 |
| Implant Planning and Surgical Guide | Lower Scan | 2 (LowerJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Implant Restorations | Upper Scan | 77 (PreppedUpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Implant Restorations | Lower Scan | 78 (PreppedLowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Implant Restorations | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Implant Restorations | Upper Scanbody Scan | 102 (UpperScanbodyScan) | No | .stl,.dcm,.ply,.obj | 1024 |
| Implant Restorations | Lower Scanbody Scan | 103 (LowerScanbodyScan) | No | .stl,.dcm,.ply,.obj | 1024 |
| Moment | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm |  |
| Moment | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm |  |
| Moment | Pictures of Patient Smiling | 74 (VeneersDesignFrontSmile) | Yes | .jpeg,.jpg,.png,.gif,.svg,.bmp |  |
| Moment | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm |  |
| Neer Veneer | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Neer Veneer | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Neer Veneer | Pictures of Patient Smiling | 74 (VeneersDesignFrontSmile) | Yes | .jpeg,.jpg,.png,.gif,.svg,.bmp | 1024 |
| Neer Veneer | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Night Guard | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Night Guard | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Night Guard | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Overdenture | Upper Jaw | 1 (UpperJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Overdenture | Upper Tissue Scan | 50 (UpperTissueScan) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Overdenture | Patient Records or Files | 52 (PhotogrammetryData) | No | .zip | 1024 |
| Overdenture | Upper Appliance Scan | 70 (UpperAppliance) | No | .stl,.ply,.obj,.dcm | 1024 |
| Overdenture | Lower Jaw | 2 (LowerJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Overdenture | Lower Tissue Scan | 51 (LowerTissueScan) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Overdenture | Upload Pictures Of Patient Smiling | 15 (PatientPhoto) | No | .jpeg,.jpg,.png | 1024 |
| Overdenture | Lower Appliance Scan | 71 (LowerAppliance) | No | .stl,.ply,.obj,.dcm | 1024 |
| Partial Denture | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Partial Denture | Supporting Images | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 100 |
| Partial Denture | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm |  |
| Partial Denture | Supporting Images | 94 (TreatmentTeethImage) | Yes | .jpeg,.jpg,.png,.gif,.svg,.bmp | 1 |
| Partial Denture | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Retainer | Upper Scan | 1 (UpperJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Retainer | Lower Scan | 2 (LowerJaw) | No | .stl,.ply,.obj,.dcm | 1024 |
| Smile Correct (up to 7 stages) | Front Face | 39 (FrontFace) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Smile Correct (up to 7 stages) | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Smile Correct (up to 7 stages) | Panorex or FMX | 38 (PanoXRayPhoto) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Front Smile | 40 (FrontSmile) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Smile Correct (up to 7 stages) | Right Side Face | 41 (RightSideFace) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Upper Jaw | 46 (UpperJawImage) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Lower Jaw | 47 (LowerJawImage) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Front Teeth | 43 (FrontTeeth) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Right Side Teeth | 44 (RightSideTeeth) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Correct (up to 7 stages) | Left Side Teeth | 45 (LeftSideTeeth) | Yes | .jpeg,.jpg,.png | 1024 |
| Smile Design | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Smile Design | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Smile Design | Pictures of Patient Smiling | 63 (SmileDesignFrontSmile) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 1024 |
| Smile Design | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Sports Guard | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Sports Guard | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Sports Guard | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Surgical Guide with Restoration | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Surgical Guide with Restoration | Upload full .ZIP file | 9 (CBCT) | Yes | .dicom,.zip | 1024 |
| Surgical Guide with Restoration | Upload any additional images | 5 (Other) | No | .jpeg,.jpg,.png,.gif,.svg,.bmp | 100 |
| Surgical Guide with Restoration | Denture/Wax Setup Scan | 49 (DentureWaxSetup) | No | .stl,.ply,.obj,.dcm | 1024 |
| Surgical Guide with Restoration | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Trial Smile | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply | 1024 |
| Trial Smile | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply | 1024 |
| Trial Smile | Bite Scan | 58 (BiteScanCombo) | No | .stl,.ply | 1024 |
| Trial Smile | Frontal | 40 (FrontSmile) | Yes | .jpg,.jpeg,.png,.bmp,.webp | 1024 |
| Trial Smile | Profile 45 Degree | 101 (Profile45Degree) | Yes | .jpg,.jpeg,.png,.bmp,.webp | 1024 |
| Trial Smile | Left Side | 42 (LeftSideFace) | Yes | .jpg,.jpeg,.png,.bmp,.webp | 1024 |
| Trial Smile | Right Side | 41 (RightSideFace) | Yes | .jpg,.jpeg,.png,.bmp,.webp | 1024 |
| Veneers | Upper Scan | 1 (UpperJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
| Veneers | Bite Scans | 58 (BiteScanCombo) | No | .stl,.ply,.obj,.dcm | 1024 |
| Veneers | Pictures of Patient Smiling | 74 (VeneersDesignFrontSmile) | Yes | .jpeg,.jpg,.png,.gif,.svg,.bmp | 1024 |
| Veneers | Lower Scan | 2 (LowerJaw) | Yes | .stl,.ply,.obj,.dcm | 1024 |
