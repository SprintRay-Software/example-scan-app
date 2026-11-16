# SprintRay 桌面扫描仪集成 — 示例应用

[English](./README.md) | 中文

https://github.com/user-attachments/assets/80a45043-70d4-439b-bcf5-5d6698d452ce

**一个来回全在里面**(53 秒,无声)—— 医生在网页端点开始扫描,本应用接管,依次扫上颌、下颌、
咬合,真的把这一单发出去,然后主动让位,浏览器回到前台,牙弓已经传上去了。其中扫描处理与上传做了
加速,其余为原速。离线阅读可看仓库内同一份文件:[`docs/demo-mode.mp4`](./docs/demo-mode.mp4)。

一个**桌面应用侧**的参考实现与**示例应用**,对应 SprintRay 的 device-login + 扫描文件上传集成。
用它理解整个流程,并在把逻辑接入你真实的桌面扫描仪应用之前完成端到端联调。

它在**同一套完整埋点的流程**(`src/core/`)之上提供两个前端:

- **桌面 UI(Electron)** —— `npm run app` —— 含两套界面:**演示模式**待机等待拉起,收到 payload 后
  仿真一次真实的椅旁扫描、真的把这一单发给 SprintRay,然后把屏幕交回浏览器;**开发者模式**展示解析
  出的启动 payload、逐步骤的实时流水线,
  以及**每一次 HTTP 请求的完整 request 与 response**,让测试者能观测到完整的数据流。连续按五次
  `d` 切换(见 [桌面 UI](#桌面-uielectron));
- **命令行运行器** —— `npm start` —— 同一套流程,输出到控制台。

两个前端还都会提供 **`127.0.0.1` 上的本机 HTTP 服务** —— 除 URL scheme 之外,Web 端触达桌面扫描仪的
第二条路径(见[本机 HTTP 服务](#本机-http-服务127001)),其中包括对其**应用更新(OTA)**接口的模拟,带有 DS
需要处理的每一种失败的开关(见 [OTA(更新)](#ota更新))。

命令行及其核心为**零依赖**(仅 Node.js ≥ 18 内置能力);Electron 仅作为可选的 `devDependency`,只在
运行 UI 时才需要,`electron-builder` 只在打包时才需要。

## 集成流程

从你的桌面应用视角,共五步 —— **无浏览器、无需重新登录,且 token 绝不出现在启动 URL 中**:

1. **拉起。** 在 treatment 页面,SprintRay Web 端通过你注册的自定义 URL scheme 拉起你的应用,
   并带上一段 base64 编码的 JSON —— `yourscheme://<base64_json>` —— 其中只含一个**一次性、短时效的 `code`**。
   (同一份 payload 也可以改为经[本机 HTTP 服务](#本机-http-服务127001)送达,前提是你的应用运行了该服务。)
2. **解码。** 对 payload 做 base64 解码,读取 `code`、token 接口路径,以及 treatment / case 标识
   (见[启动 payload](#启动-payload))。
3. **换取 token。** 通过 HTTPS 把 `code` + 你的客户端凭据 POST 上去,换取已登录医生的 `access_token`。
4. **上传。** 扫描仪一次就把上下颌都扫完,所以整口扫描(启动 payload 的 `fileType` 为 `null`)会为**两个**文件
   各申请一次预签名上传 URL 并 PUT —— 文件之间没有先后依赖,可以并发发出;`fileType` 指定某一颌时只传那一个。每次上传都要声明这个文件是什么
   扫描类型(`externalScanFileType`)。扫描文件会自动挂到 treatment 上。
5. **收尾。** 调用一次扫描结束接口,并随调用上报本次会话扫到了什么 —— 扫描模式、缺失牙位、分割牙齿、
   扫了哪几颌。SprintRay 会返回一批预签名链接,你把分割牙齿与牙龈网格 PUT 上去即可。所有元数据字段
   都是可选的:什么都不报,这个调用照旧把会话收尾,与此前完全一致。

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
    loop 每个扫描文件，并发进行（整口扫描 = 上颌 + 下颌）
        App->>BE: 申请预签名上传 URL（请求体带 scanJobId + externalScanFileType）
        BE-->>App: 预签名上传 URL
        App->>S3: PUT 原始文件字节
        S3-->>App: 200 / 204
    end
    App->>BE: 本次扫描会话结束（id + 扫描元数据）
    BE-->>App: 200 + 预签名链接（分割牙齿、牙龈）
    opt 上报了分割牙齿 / 颌位
        App->>S3: PUT tooth_N.ply + 牙龈网格（并发）
        S3-->>App: 200 / 204
    end
    BE-->>Web: 扫描会话状态事件
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
    "tokenEndpoint": "/integration/device-login-token",
    "expiresIn": 600
  },
  "treatmentId": "<treatment id>"
}
```

| 字段 | 用途 |
|---|---|
| `caller` | 拉起方(`SprintRay` + Web 端版本) |
| `case.name` | 患者显示名 |
| `case.ID` | **本次拉起的扫描会话**。每次上传以及扫描结束调用都要把它作为 `scanJobId` 传回 |
| `treatment.teeth[]` | 选中的牙位 —— `teeth`(牙号)、`notes`、`toothApplianceType`、`groupNumber` |
| `fileType` | 请求的文件类型(`TreatmentFiles`;见 [枚举](#枚举));整口扫描时为 `null`,此时上下颌两个文件都要上传 |
| `language` | 界面语言,如 `en_US` |
| `serverType` | 服务器类型标识 |
| `toothSystem` | 牙位编号系统:`fdi` 或 `utn` |
| `auth.code` | 用于换取 token 的一次性 device-login code |
| `auth.tokenEndpoint` | token 接口**路径** —— 拼接到后端 origin 之后 |
| `auth.expiresIn` | code 有效期(秒) |
| `treatmentId` | 上传的扫描文件要挂载到的 treatment |

> `auth`、`treatmentId` 是 SprintRay 的静默鉴权与上传上下文;
> 其余为标准 ScanPro 启动 payload。

## 接口约定

共三个调用。它们都经由 SprintRay API 网关,`{ORIGIN}` 为对应环境下固定的网关 origin:

| 环境 | `{ORIGIN}` |
|---|---|
| 开发 | `https://dev-apx.sprintray.com` |
| 预发 | `https://staging-apx.sprintray.com` |
| 生产 | `https://apx.sprintray.com` |

对应环境的 origin 由 SprintRay 提供。

**每个调用都必须带上 `x-api-key`** —— SprintRay 为你的集成签发的网关 API key(与 client id / client
secret 是两回事:API key 标识调用方并决定限流额度,client 凭据用于换取医生 token)。缺少该头会在
请求到达 SprintRay 后端之前被网关以 `403` 拒绝。

> 网关路径**不含** `/api` 前缀。请始终使用启动 payload 中的 `auth.tokenEndpoint` 拼接 token 接口,
> 不要写死路径 —— 该字段就是为了让 SprintRay 能在不改动你的应用的前提下调整路由。

### 1. 用 code 换取 token

```http
POST {ORIGIN}{auth.tokenEndpoint}
x-api-key: <your-api-key>
Content-Type: application/json

{ "code": "<code>", "clientId": "<your-client-id>", "clientSecret": "<your-client-secret>" }
```

`200 → { "access_token": "…", "token_type": "Bearer", "expires_in": 86400 }`

错误:`400` code 缺失/过期/已使用 · `401` 客户端凭据错误 · `403` 缺少或无效的 `x-api-key`。
token 过期后,重新拉起以获取新 token。

### 2. 申请预签名上传 URL,再 PUT 文件

```http
POST {ORIGIN}/integration/file/upload
Authorization: Bearer <access_token>
x-api-key: <your-api-key>
Content-Type: application/json

{ "fileName": "upper.stl", "fileSize": 3083734, "treatmentId": "<treatment-id>",
  "scanJobId": "<启动 payload 中的 case.ID>",
  "treatmentFileType": 1, "arch": 1, "externalScanFileType": "Upper" }
```

`200 →` 一个预签名上传 URL(JSON 字符串,或 `{ "url": "…" }`)

```http
PUT <presignedUrl>
Content-Type: application/octet-stream
Content-Length: <fileSize>

<原始文件字节>
```

成功返回 `200`/`204`。PUT 请求**不带**鉴权头 —— 预签名 URL 自带授权。

- `scanJobId`:即启动 payload 中的 `case.ID`,标识该文件所属的扫描会话。**每次上传都要带上** ——
  SprintRay 靠它跟踪会话进度;对于不携带 treatment 的拉起,这也是其上传能被记录下来的唯一途径。
  `treatmentId` 仍各司其职,负责把文件绑定到 treatment,两者并存。
- `externalScanFileType`:**每次上传必传。** 即**你自己对这个文件的命名** —— `Upper`、`LowerJaw`、
  `BiteScan`,你的应用本来怎么叫就怎么传,不必迁就 SprintRay 的编号。SprintRay 首次见到某个名字时,
  会把它登记在你这个集成名下;之后由 SprintRay 管理员一次性把它映射到对应的 SprintRay 文件类型和/或
  indication,从此以该名字上传的文件,其文件类型就**由该映射决定**,优先于你传的 `treatmentFileType`。
  映射建立之前,文件照样保存、照样记录在会话上,只是没有 SprintRay 文件类型 —— 所以请在联调阶段就把
  **你的应用会用到的名字清单**交给 SprintRay
  (见〈你需要向 SprintRay 索取的信息〉),而不是等第一次上传把名字带进来。匹配时不区分大小写,
  但 SprintRay 存下来的是它第一次见到的写法,因此每次都用同一种拼写。(该字段不会以 `400` 强制校验 ——
  不带它的上传照样成功,好让这套契约之前写好的客户端继续可用。它是**对你这个集成的要求**:不传它,
  文件类型就无从映射。)
- `treatmentFileType`:**`1` = 上颌,`2` = 下颌**。可选,且只作**兜底**:当你的 `externalScanFileType`
  已经映射到某个 SprintRay 文件类型时,文件类型由该映射决定,这里传的值不生效。它只负责映射给不出结果
  的情形 —— 名字已登记、但还没映射到文件类型 —— 所以联调阶段请一并带上;等你的名字都映射好之后,
  它就不再影响结果了。
- `arch`(可选):**`1` = 上颌,`2` = 下颌**。这个文件扫的是哪一颌。没有具体颌位的文件(比如咬合扫描)
  可以不传。扫描结束调用上报的元数据正是按它来分配的,所以不传 `arch` 的文件不会被挂上缺失牙位与
  分割牙齿信息。
- **不要多传别的字段。** 会话是 `scanJobId`,case 是 `treatmentId`,SprintRay 认的就是这两个;
  SprintRay 其他上传流程里的字段在这里没有任何意义。
- 扫描文件为 **STL** 格式。
- **文件之间互不依赖。** 申请链接和 PUT 都只针对单个文件，契约里也没有规定它们的先后顺序，因此
  上行带宽允许的话可以同时发多个：整口会话的两颌一起发，下面的网格链接分批发。契约唯一强制的顺序
  是扫描结束调用必须在最后一个扫描文件上传之后。

### 3. 告知 SprintRay 本次扫描会话已结束

在**最后一个扫描文件上传完成后调用一次**。上传文件本身并不表示"扫描结束":SprintRay 只能看到每颌各一个
上传事件,无法区分"上颌到了"与"医生扫完了"。这个调用负责把会话收尾,并推送 Web 端一直在等的事件,
医生的浏览器据此离开扫描页面。

同时,它也是你**上报本次会话扫到了什么**的地方 —— 扫描模式、缺失牙位、分割牙齿、扫了哪几颌 ——
SprintRay 则在响应里给出分割牙齿与牙龈网格的预签名上传链接。

```http
POST {ORIGIN}/integration/scan-job/complete
Authorization: Bearer <access_token>
x-api-key: <your-api-key>
Content-Type: application/json

{
  "id": "<启动 payload 中的 case.ID>",
  "scanMode": "quickScan",
  "hasUpper": true,
  "hasLower": true,
  "missingTeeth": [1, 16],
  "segmentedTeeth": [
    { "toothNumber": 8, "filename": "tooth_8.ply", "confidence": 0.97, "condition": "prepared" }
  ]
}
```

`200 →` 结束后的会话,外加你上报的每个网格各一条预签名 PUT 链接:

```json
{ "id": "<scan-job id>", "treatmentId": "<treatment id 或 null>", "caseId": "<external case id>",
  "status": 3, "externalProviderId": "scanpro",
  "files": [ { "fileType": 1, "fileGuid": "…", "status": 3 } ],
  "scanMode": "quickScan", "missingTeeth": [1, 16], "hasUpper": true, "hasLower": true,
  "segmentedTeethUploadLinks": [ { "toothNumber": 8, "url": "https://…" } ],
  "gingivaUploadLink": { "upper": "https://…", "lower": "https://…" },
  "createdDate": "2026-08-20T07:31:00Z", "modifiedDate": "2026-08-20T07:36:12Z" }
```

- `id` 是定位会话的键,就是启动 payload 里的 `case.ID`。`scanJobId` 是同一个字段的旧名字,**仍然受支持**,
  已发布的应用无需改动;两者都传时以 `id` 为准。
- **所有元数据字段都是可选的。** 只传 `{ "id": "…" }` 的请求体,与此前完全一样地结束会话 ——
  你的扫描仪实际产出什么就报什么。
- `scanMode`:**用你自己的词汇** —— `quickScan`、`restorative`,你的应用怎么叫就怎么传,与上传调用里的
  `externalScanFileType` 是同一套约定。SprintRay 首次见到某个名字时会把它登记在你这个集成名下;
  存下来的是第一次见到的写法,所以请保持稳定。
- `missingTeeth` 与 `segmentedTeeth[].toothNumber` 一律是**通用牙位编号(Universal,1-32)** ——
  启动 payload 里的 `toothSystem` 只影响展示,与这个调用无关。
- `hasUpper` / `hasLower`:本次会话是否扫了对应那一颌。牙龈链接由它们决定 —— 没有 `hasLower`,
  就没有 `gingivaUploadLink.lower`。
- `segmentedTeeth[]` 声明的是你**接下来要上传**的逐牙网格:牙位号 `toothNumber`、你将使用的文件名
  `filename`、分割置信度 `confidence`,以及该牙的状态 `condition`。每颗牙返回一条链接,放在
  `segmentedTeethUploadLinks` 里。
- `segmentedTeeth[].condition` 描述这颗牙**是什么状态**。与 `scanMode` 不同,它用的是 SprintRay 的
  词汇而不是你的,取值只有这三个:

  | `condition` | 含义 |
  |---|---|
  | `prepared` | 已备牙 —— 完成预备、有边缘线,待做修复体 |
  | `missing` | 该牙位缺失,网格覆盖的是牙位本身 |
  | `restored` | 已有修复体 —— 牙冠、嵌体、充填 |

  该字段**可选、可为 null**:你的扫描仪没有判断的牙位,不传这个键或传 `null` 均可。不传不等于
  `missing` —— 只有扫描仪确实判定这颗牙缺失时才报 `missing`。
- **幂等,元数据也一样。** 重试会重新签发指向**同一批**对象的链接,已经 PUT 上去的网格不会丢;
  上报的元数据是覆盖写,所以用同样的请求体重试会收敛到同一结果。对已经结束的会话上报元数据同样有效 ——
  提交 treatment 会在 SprintRay 侧把会话结束掉,这一步有可能先于你的调用发生。
- 会话一旦结束就不再接收**扫描文件**上传。重扫是一次新的拉起、一个新的会话。本次调用拿到的网格链接
  仍然可用(见下)。

拿到链接后,逐个把网格 PUT 上去:

```http
PUT <segmentedTeethUploadLinks[].url | gingivaUploadLink.upper | gingivaUploadLink.lower>
Content-Type: application/octet-stream
Content-Length: <fileSize>

<原始网格字节>
```

- 规则与扫描文件的 PUT 相同:**不带**鉴权头,成功返回 `200`/`204`。链接有效期为 **30 分钟** ——
  过期后再调一次结束接口,即可拿到指向同一批对象的新链接。
- 对象的扩展名取自你上报的 `filename`(`tooth_8.ply`)。上报时没给文件名的牙齿,以及所有牙龈网格,
  由 SprintRay 命名,默认使用 **`.ply`**。
- PUT 之后**不需要再调任何接口** —— 没有 confirm,也不用再调一次结束接口。这些网格属于会话元数据,
  不是 treatment 文件:它们不会挂到 treatment 上,也不会出现在医生的 Cloud Drive 里。

错误:`400` 完全没传 id、牙位号超出 1-32、同一个 `toothNumber` 出现两次、`filename` 的扩展名不被允许,
或 `condition` 的取值不在枚举内 · `401` access token 缺失或过期 · `403` 缺少或无效的 `x-api-key` ·
`404` 会话不存在,**或**属于其他医生(两者故意不作区分)。

最后那个 `400` 值得单独留意,因为它和你发送的其它名字**行为不同**:`scanMode` 与
`externalScanFileType` 是自由词表 —— SprintRay 没见过的名字会被登记在你的集成名下,调用照样成功;
`condition` 是封闭枚举,拼错会让**整个**结束调用失败,既不会被登记,也不会被悄悄忽略。不传这个键
或传 `null` 一律合法 —— 报错针对的是"传了、但值不对"。

### 4. 读取扫描会话（可选）

你的应用并不需要这个接口,这里列出是因为它是同一个会话资源。它回答的是"SprintRay 目前收到了哪几颌、
会话处于什么状态" —— 扫描中途出问题、想确认到底落了哪些文件时有用。

```http
GET {ORIGIN}/integration/scan-job/{scanJobId}
Authorization: Bearer <access_token>
x-api-key: <your-api-key>
```

`200 →` 与结束调用相同的响应结构,但不含上传链接 —— 包含上报过的 `scanMode`、`missingTeeth`、
`hasUpper`、`hasLower`(未上报过的会话上这些为 null)。错误同上:`401` · `403` · `404`。

`status` 取值:`1` pulled · `2` transferring · `3` done。文件级 `status`:`1` pending ·
`2` uploaded · `3` 已挂载到 treatment。两个来源都给不出结果时,该文件的 `fileType` 为 `null` ——
即它的 `externalScanFileType` 没有映射到文件类型,上传也没有带 `treatmentFileType`。

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

### `arch` —— `ArchType`

一次上传扫的是哪一颌(上传调用里的 `arch`)。可选 —— 没有具体颌位的文件(比如咬合扫描)可以不传。

| 取值 | 含义 |
|---|---|
| `1` | 上颌 |
| `2` | 下颌 |
| `3` | 双颌 —— 一个文件承载整口 |

一颌一个文件的扫描仪只会用到 `1` 和 `2`。`3` 用于单个文件同时承载上下颌:结束调用下发的元数据里,
`1` 只拿 1-16、`2` 只拿 17-32,而 `3` 拿**整套** 1-32。

### `toothSystem`

由医生的牙位编号偏好(`DentalNotation`)映射而来的字符串:

| `toothSystem` | 含义 |
|---|---|
| `utn` | 通用牙位编号 Universal Tooth Numbering(`DentalNotation.Utn` = 1)—— 默认 |
| `fdi` | FDI 世界牙科联盟编号(`DentalNotation.Fdi` = 2) |

它决定的是牙位**如何展示给医生**。你发给 SprintRay 的牙位号 —— 扫描结束调用里的 `missingTeeth` 与
`segmentedTeeth[].toothNumber` —— 一律是**通用编号(1-32)**,与 `toothSystem` 无关。

### `serverType`

目前没有为其定义枚举,始终为固定值 `0`。

## 你需要向 SprintRay 索取的信息

| 值 | 环境变量 | 说明 |
|---|---|---|
| 网关 origin | `SCANPRO_BASE_URL` | 按环境固定(dev / staging / prod,见上表) |
| 网关 API key | `SCANPRO_API_KEY` | 每次调用(含遥测)都作为 `x-api-key` 发送;标识调用方并决定限流额度 |
| Client ID | `SCANPRO_CLIENT_ID` | 你集成的公开 id |
| Client Secret | `SCANPRO_CLIENT_SECRET` | 仅保存在服务端 / 你的应用内 |
| URL scheme | `SCANPRO_URL_SCHEME` | 你的应用注册的 scheme,如 `openScanPro` |

还有一项不属于凭据,而且方向相反,但属于同一批联调事项:`externalScanFileType` 每次上传必传,
所以请把**你的应用会用到的名字清单**(连同扫描结束调用里的 `scanMode` 名字)提供给 SprintRay,
由管理员把每个名字映射到对应的 SprintRay 文件类型 / indication。名字映射之前,以它上传的文件
不带 SprintRay 文件类型。

## 运行示例应用

前置条件:Node.js ≥ 18(`--env-file` 需 ≥ 20.6)。支持 macOS / Windows / Linux(scheme 注册以 macOS 为已验证路径)。

```sh
cp .env.example .env.dev  # 填入 origin、client id/secret、scheme
```

每个环境一个文件 —— `.env.dev`、`.env.staging`、`.env.prod` —— 都在 .gitignore 里(只有
`.env.example` 会提交)。CLI 读 `.env`;桌面 UI 读对应 npm script 指定的那个文件。

## 桌面 UI(Electron)

```sh
npm install               # 会安装 Electron(devDependency)
npm run app               # 启动桌面 UI,读 .env.dev
npm run app:staging       # 读 .env.staging
npm run app:prod          # 读 .env.prod
```

想用别的文件不必改 package.json —— 上面这些 script 传的就是这个参数:

```sh
npm run app -- --env-file=.env.qa        # 也可以用 SCANPRO_ENV_FILE=.env.qa,
                                         # 供无法传参的启动方式使用(URL scheme、Finder 双击)
```

**Configuration** 标题旁边会写出这次实际加载的是哪个文件,跑错环境一眼就能看见。

同一套流程上有**两套界面**,任何时候**连续按五次 `d`** 即可互相切换:

| 界面 | 用途 | 是否默认进入 |
|---|---|---|
| **演示模式(Demo)** | 展示这套集成在医生眼里是什么样 | 是 |
| **开发者模式(Developer)** | 联调集成、查看网络流量 | `SCANPRO_UI_MODE=dev` |

### 演示模式

[开头那段视频](#sprintray-桌面扫描仪集成--示例应用)录的就是这套界面。

对真实口内扫描仪软件的仿真:暗色舞台、两侧工具栏、实时相机预览、扫描质量图例。它的**生命周期就是
桌面应用真实的那一套**,和开发者模式一致:

1. **待机。** 窗口空转等待,卡片上写着当前可用的拉起通道(URL scheme,以及本机服务监听的端口)。
   不扫任何东西。
2. **收到启动 payload** —— 来自系统 URL scheme,或本机服务的 `POST /scanpro/v1/start` —— 这一单
   开始播:上颌在虚拟扫描杖下逐步生成(用的是随包的 STL 牙弓,按扫描顺序逐三角面显现,原始网格上
   标出空洞与分层),接着下颌,然后咬合配准,最后一遍精修:补洞、平滑,得到最终模型。患者姓名、
   case id、选中的牙位都取自 payload;payload 指定了 `fileType` 时只扫那一个牙弓。播放中又来了新
   payload,则按新的这一单重新开始。
3. **返回浏览器。** 这一单发出去之后,完成卡倒计时结束,应用主动让位 —— macOS 上隐藏、Windows 上
   最小化 —— 医生原来那个页面重新回到前台;下一次拉起会把窗口带回来。上传失败则卡片留在屏幕上,
   等人手动关掉。

**上传是真的。** 它调用的就是开发者模式里那个 `runFlow()`:只要 `.env` 里的凭据齐全,这一单就真的
会走完换 token、上传、结束扫描会话 —— 卡片上的进度是真实的 HTTP 进度,完成卡上的 treatment 与文件
大小也是后端实际接收的。缺少凭据时,卡片会写明原因,传输为模拟。

### 开发者模式

推荐用于联调的方式。它运行与命令行完全相同的流程,但以可视化方式呈现,便于观测每个步骤并检查
网络上传输的每一个字节。窗口分三块:

- **左侧 —— 配置与输入。** 网关 origin、API key、client id/secret、URL scheme 会从 `.env` 预填(可按次修改)。
  粘贴 `openScanPro://<base64>` **启动 URL**,或切到 **Manual code** 用显式 `code` + treatment id 运行;
  **Upload** 区按颌位分开:可选地指定自定义扫描文件,以及该文件上传时使用的 `externalScanFileType` ——
  预填为 `$SCANPRO_SCAN_FILE_TYPE_UPPER` / `_LOWER`(否则 `Upper` / `Lower`),下拉建议是 ScanPro 自己的
  扫描类型名(`UpperPreOp`、`UpperAd`、`FreeScan` 等),也接受任意其他名字,便于观察一个名字如何被登记、
  映射后又如何决定文件类型。需要的话勾选额外走 token 刷新步骤。**Tooth conditions**
  即 `--tooth-condition` 的牙位图版本:先选一种 condition,再点属于它的牙齿(再点一次取消),
  图下方那行给出等价的命令行参数值,可直接复制到 CLI 复现同一次运行。牙位号一律为 universal
  编号(上排 `1`&ndash;`16`,下排 `32`&ndash;`17`);解析出 payload 后,本次不采集的那一颌会置灰
  —— 上报时这些牙齿会被丢掉。
- **右侧 —— 观测区。**
  - **Pipeline** —— 桌面应用侧的步骤按序展示(解析 → 换 token → 可选刷新 → 预签名 URL → S3 PUT →
    结束会话 → PUT 牙齿/牙龈网格),每步显示实时状态与一行摘要。
  - **Decoded launch payload** —— 解析出的字段(`code`、`tokenEndpoint`、`treatmentId`、`scanJobId`、
    `fileType`)以及完整的解码 JSON;**Decode payload** 可在不发起网络请求的情况下预览。
  - **HTTP transactions** —— 每次调用一张可展开的卡片,包含**完整 request**(method、URL、headers、body)
    与**完整 response**(status、headers、body、耗时);body 会格式化并可复制,S3 PUT 的 body 显示为
    `<binary N bytes>`。
  - **Log** —— 与命令行一致的带时间戳 step/ok/fail/info 流。
- **左侧底部 —— OTA simulator。** 本机服务实时的 `/update/status`,以及应用更新的模拟器开关:下载方式与速度、
  重启停机时长、换端口、ScanPro 是否报告为运行中、强制失败或卡住,以及其他故障情形。见 [OTA(更新)](#ota更新)。

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

追加 `--demo-refresh` 可一并演示 token 刷新接口;`--upper-file <p>` / `--lower-file <p>` 可替换某一颌
要上传的文件;`--concurrency <n>` 控制同时上传几个文件(默认取 `$SCANPRO_UPLOAD_CONCURRENCY`,
否则 4;传 `--concurrency 1` 即逐个上传)。

结束调用上报的扫描信息,默认由本次运行实际上传的颌位推导得出,每一部分都可以覆盖:

| 参数 | 作用 |
|---|---|
| `--scan-mode <name>` | 上报的 `scanMode`(默认取 `$SCANPRO_SCAN_MODE`,否则 `quickScan`) |
| `--missing-teeth 1,16` | 上报的 `missingTeeth`,通用牙位编号(默认:没有缺失牙) |
| `--segmented-teeth 8,9` | 上报并上传的牙位 —— 传 `none` 表示一颗都不报(默认:所报颌位中除缺失牙以外的全部牙位) |
| `--tooth-condition 8=prepared,9=restored` | 逐牙上报的 `condition` —— `prepared` / `missing` / `restored`(默认:每颗牙都是 `null`) |
| `--no-metadata` | 什么都不报:结束调用只带 id,与这套契约之前写好的客户端行为一致 |
| `--upper-scan-type <n>` / `--lower-scan-type <n>` | 各颌上传时发送的 `externalScanFileType`(默认取 `$SCANPRO_SCAN_FILE_TYPE_UPPER` / `_LOWER`,否则 `Upper` / `Lower`) |
| `--tooth-file <p>` / `--gingiva-file <p>` | PUT 到每个返回链接的网格文件(默认 `fixtures/tooth.ply` / `fixtures/gingiva.ply`) |

因此,一次不带任何参数的整口运行会上报双颌、32 颗分割牙、无缺失牙 —— 换回 34 个预签名链接,
随后是 34 次 PUT。想快速看完整流程又不想等,用 `--segmented-teeth none`:只剩两个牙龈网格。

### 它做了什么

每次运行会:换取 token,然后按扫描仪的真实行为上传 —— 整口扫描(`fileType` 为 `null`)会同时上传
`fixtures/upper.stl` 与 `fixtures/lower.stl` 两个文件,`fileType` 指定某一颌时只上传那一个 —— 
进度条按整批统计,每个文件都会带上自己的扫描类型(`externalScanFileType`)和所属颌位(`arch`)。

上传是并发的,但日志不会交错:每个文件先写进自己的缓冲区,再按文件顺序整段打印出来,所以字节在
网络上重叠的同时,请求 / 响应日志读起来仍然是一个文件接一个文件。

最后一个文件上传完成后会发起扫描结束调用,并上报本次会话扫到了什么:扫描模式、哪几颌、分割出的牙齿
(每颗都带 `condition`,未用 `--tooth-condition` 指定时为 `null`)、缺失的牙齿。SprintRay 会按每颗
分割牙一条、每个已扫颌位的牙龈一条返回预签名链接,本应用分批并发 PUT 上去 ——
整个流程与真实会话完全一致。这些网格属于会话元数据:PUT 之后没有任何后续调用,也不会出现在医生的
Cloud Drive 里。形式 B(`--code`,无启动 URL)没有 `case.ID`,也就没有会话可结束,这两步都会标记为
skipped。

换取 token 之后还会上报一条遥测事件 `scanner.connected` —— 那是本次拉起第一次知道医生是谁的时刻,
见[遥测](#遥测)。

**每个后端请求与响应都会被完整打印**(方法、URL、请求头、请求体 / 状态码、响应头、响应体),
让你清楚地看到该发送什么、该期望什么。把 `fixtures/` 里的文件替换成你自己的扫描件即可测试其它数据 ——
`upper.stl` / `lower.stl` 是两颌扫描件,`tooth.ply` / `gingiva.ply` 则是逐牙网格与牙龈网格的替身。

## 本机 HTTP 服务(`127.0.0.1`)

Web 端触达桌面应用的**第二条路径**。不走系统 URL scheme,而是由浏览器在回环地址上探测一个固定端口
区间,找到常驻服务后把 payload POST 过去。两条路径携带的是**同一份** base64 JSON payload,在本示例
应用里也都落到同一个窗口。

本应用实现了该契约的服务端,你可以把 Web 端直接指过来,看到调用方真实看到的一切 —— 尤其是 CORS 行为,
浏览器访问回环地址的集成通常就断在这里。

桌面 UI 启动时会自动拉起该服务,右上角 **server** 芯片显示它占用的端口(悬停可看接口列表)。
不带 Electron 单独运行:

```sh
npm run serve                  # 占用端口;/start 通过 URL scheme 拉起桌面应用
npm run serve -- --run-flow    # /start 改为在进程内换取 token 并上传扫描文件
npm run serve -- --help        # 全部选项:端口区间、上报的版本/状态、Host 校验开关、OTA
```

无头模式下,`/start` 会像真实的常驻服务那样拉起应用 —— 把 payload 交给该 URL scheme 的系统处理器,
于是 `npm run register` 注册的、或已安装的构建就是被拉起的那个。拉起之后还会**做确认**:启动器返回 0 只
代表系统受理了请求,一个启动后立刻退出的陈旧处理器本来会被当成成功,所以响应里报的是实际结果:

| `errorCode` | 含义 |
|---|---|
| `NO_HANDLER_REGISTERED` | 没有程序认领该 scheme —— 安装一个构建,或执行 `npm run register` |
| `LAUNCH_NOT_CONFIRMED` | 系统受理了启动,但没有进程活下来(通常是陈旧的处理器) |
| `LAUNCH_FAILED` | 系统启动器本身报错 |

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

这一条不带 `scanner` —— 该故障与口扫设备无关,而批次只在需要的事件上带 `scanner`;也不带 `userId` ——
该服务在任何人登录之前就已启动,规范宁可这个字段缺失,也不要一个占位值。其余发送规则见下面的[遥测](#遥测)。

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

## OTA(更新)

本机服务还模拟了 `ScanPro_OTA_API.md`(v1.1)定义的**应用更新**:Web 端让服务先下载新的 ScanPro 安装包、
再安装,两步都通过轮询跟进。在 Allied Star 交付任何构建之前,可以用它开发和测试 Scan tab 的更新流程(下载 →
安装 → 进度 → 结果、刷新页面、端口变化、各种失败)。

**只模拟 `target: "app"`。** 模拟器不实现固件更新:`target: "firmware"` 的请求按契约是合法的,但一律返回
`400 E_UPDATE_UNSUPPORTED`(服务无法执行该更新时用的错误码)。这里永远不会出现 `updating_firmware` 阶段、
扫描仪相关的失败码以及 `scanner.firmware_update_completed`。

两个前端都提供:`npm run serve` 和桌面应用。下载**默认是模拟的** —— 不联网,进度按 64 MB/s 假装下载真实
安装包的 2.1 GB;加 `--real-download` 才会真正流式下载 `package.url`。

| | 方法 | 路径 | 返回 |
|---|---|---|---|
| 1 | `POST` | `/scanpro/v1/update` | 立即返回 `200 { action, target, phase, fromVersion, toVersion }` |
| 2 | `GET` | `/scanpro/v1/update/status` | `{ action, target, phase, percent, fromVersion, toVersion, startedAt, updatedAt, error }` |

请求体为 `{ action, target, package }`:

```json
{
  "action": "download",
  "target": "app",
  "package": {
    "version": "1.0.45.0",
    "url": "https://cdn.example.com/scanos/ScanOS_1.0.45.0.exe",
    "md5": "ddb59700ca49a13e3d2ef95756dc6ec5"
  }
}
```

`action` 为 `download` 或 `install`。install 请求带**与下载时相同的 `target` 和 `package`**,服务据此找到已下载的
包。`md5` 可选,比较时不区分大小写。

### 阶段

```
download   downloading ─▶ verifying ─▶ downloaded
install    verifying ─▶ installing ─▶ restarting ─▶ (服务被替换) ─▶ completed
           任一步都可能以 failed 结束,error = { code, message }
```

| `phase` | 步骤 | `percent` | 模拟器的行为 |
|---|---|---|---|
| `idle` | — | `null` | 从未执行过更新 |
| `downloading` | 下载 | 0–100 | 流式下载 `package.url`(real)或累计假字节(simulated) |
| `verifying` | 两者 | `null` | 下载后:按 `package.md5` 校验 MD5;安装前:重新计算文件哈希、再校验 MD5,外加模拟的 Authenticode 校验 |
| `downloaded` | 下载 | `100` | 包已落盘并通过校验,等待 `install` |
| `installing` | 安装 | `null` | "安装器"运行(`--install-time`,默认 4 s) |
| `restarting` | 安装 | `null` | 先保持可见 `--restart-hold`(2.5 s,比 Scan tab 的 2 s 轮询间隔长),随后 **HTTP 服务关闭**,停机 `--restart-delay`(5 s),新服务重新起来 —— 加 `--port-switch` 时换一个端口 |
| `completed` | 安装 | `100` | 新服务读到 `version = toVersion`,`/status` 此后报告新版本 |
| `failed` | 两者 | 保持 | `error.code` 说明原因 |

**重启之后**,新服务按 §4.5 对真实服务的要求行事:读取持久化的状态,比较已安装版本与 `toVersion`,置
`completed` 或 `failed / E_INSTALL_FAILED`。内存中的状态不会跨越重启,只有模拟器开关会保留。

**包的保留**遵循 §4.4:每个 target 只保留一个包;安装成功或校验失败后删除,其他原因的安装失败则保留,可直接再次
调用 `install`。再次下载同一个包会立即返回 `phase: "downloaded"`。

**落盘位置。** 状态和包保存在 state 目录下(`~/.sprintray-scanpro-example/ota/`;桌面应用中为 user-data 目录;
可用 `--state-dir` 或 `$SCANPRO_STATE_DIR` 修改)。它们在模拟重启和模拟器自身重启后都还在,状态保留到下一次被接受的
`POST /update`;被拒绝的 POST(任何 4xx)不会改动它。更新之后,`/status.version` 一直报告已安装的版本;传
`--version` 可以从指定版本重新开始,`--ota-reset` 会清掉所有更新记录。

### 关闭并重新打开页面

下载和安装**在服务里运行,而不是在页面里**:没有任何人轮询时进度也在推进。页面在某一步中途关闭、再打开时,自身没有
任何状态 —— 它探测端口区间,读一次 `GET /update/status`,就能拿到实时的 `phase`、`percent`、`toVersion` 以及
最初的 `startedAt`。服务从 `restarting` 回来换了端口之后,以及模拟器自身重启之后,依然如此:

- 已结束的步骤(`downloaded`、`completed`、`failed`)按原样报告;
- 未完成的**下载**在新进程中继续 —— 模拟下载从保存的百分比接着走,真实下载从头开始。契约没有规定是哪一种;传
  `--interrupted-download fail` 可以让新服务改报 `failed / E_DOWNLOAD_FAILED`,以便 Scan tab 两种情况都测到;
- 未完成的**安装**会以 `failed / E_INSTALL_FAILED` 回来,包保留,因为磁盘上的版本没有变(§4.5)。

### 错误

请求级错误沿用 `/start` 的信封格式,使用契约中的错误码:

| 状态码 | `code` | 何时 |
|---|---|---|
| `400` | `E_INVALID_ARGUMENT` | JSON 不合法;`action` / `target` 取值不对;缺少 `package`;`version` 或 `url` 缺失或为空;`url` 不是 `https://` 绝对地址;给了 `md5` 但不是 32 位十六进制 |
| `400` | `E_SCAN_NOT_INSTALLED` | `/status` 会报 `installed: false` |
| `400` | `E_UPDATE_UNSUPPORTED` | `target: "firmware"`(未模拟),或 `--ota-unsupported` |
| `400` | `E_UPDATE_IN_PROGRESS` | 已有下载或安装在进行 |
| `400` | `E_ALREADY_UP_TO_DATE` | 已安装版本 ≥ `package.version`(按段比较,缺段补 0) |
| `400` | `E_PACKAGE_NOT_DOWNLOADED` | `install` 时没有与 `target` + `package` 匹配的已下载包 |
| `400` | `E_SCAN_ALREADY_RUNNING` | `/status` 报 `running: true` 时 `install`;下载不受影响 |
| `503` | `E_INACTIVE_SESSION` | `--inactive-session`:所有路径(含 `OPTIONS`),在任何 CORS 头之前 |
| `404` | `NOT_FOUND` | `--no-update-route`:没有 OTA 接口的旧版服务 |

模拟器自己会产生的 `phase = failed` 错误码:`E_DOWNLOAD_FAILED`(网络、HTTP 非 2xx、数据不完整、
`--interrupted-download fail` 下的中途重启)、`E_INSUFFICIENT_DISK_SPACE`(真实下载大于剩余空间)、
`E_VERIFY_FAILED`(MD5 不一致、文件在磁盘上被改动、签名不通过;包被删除)、`E_INSTALL_FAILED`(安装中途服务停止,
或新服务报告的版本不对)。`E_USER_CANCELLED`、`E_TIMEOUT`、`E_UNKNOWN` 可以强制注入(见下文)。

`POST /update` 带 JSON body,浏览器会先发预检。`/update` 的预检与 `/start` 一样能通过,包括 Private Network
Access(见 [CORS](#cors-与-chrome-的-private-network-access))。

### 用 curl 走一遍

以待测版本和较短的模拟下载启动服务:

```sh
npm run serve -- --installed --version 1.0.44.9 --simulated-size 200 --download-speed 20 \
  --restart-delay 4 --port-switch --sim-control
```

`--installed` 让 ScanPro 即使没有注册 URL scheme 处理器也报告为已安装 —— 否则 OTA 会以 `E_SCAN_NOT_INSTALLED`
拒绝。

```sh
B=http://127.0.0.1:29083/scanpro/v1
PKG='{"version":"1.0.45.0","url":"https://cdn.example.com/scanos/ScanOS_1.0.45.0.exe","md5":"ddb59700ca49a13e3d2ef95756dc6ec5"}'

# 1. 下载 —— 立即返回
curl -s -X POST $B/update -H 'Content-Type: application/json' \
  -d "{\"action\":\"download\",\"target\":\"app\",\"package\":$PKG}"
# {"action":"download","target":"app","phase":"downloading","fromVersion":"1.0.44.9","toVersion":"1.0.45.0"}

# 2. 关闭页面:一段时间内什么都不发,然后由一个全新的客户端读一次状态
sleep 4; curl -s $B/update/status
# {"action":"download","target":"app","phase":"downloading","percent":38,...,"startedAt":"…:48.344+08:00",...}

# 3. 约 10 s 后
curl -s $B/update/status
# {"action":"download","target":"app","phase":"downloaded","percent":100,...}

#    可选:停掉模拟器(Ctrl+C)再启动,状态仍然是 "downloaded"。

# 4. ScanPro "运行中"(模拟器开关)时安装 → 被拒绝
curl -s -X POST $B/_sim -H 'Content-Type: application/json' -d '{"scanPro":{"running":true}}' >/dev/null
curl -s -X POST $B/update -H 'Content-Type: application/json' \
  -d "{\"action\":\"install\",\"target\":\"app\",\"package\":$PKG}"
# {"error":{"code":"E_SCAN_ALREADY_RUNNING","message":"ScanPro is running; close it before installing"}}
curl -s -X POST $B/_sim -H 'Content-Type: application/json' -d '{"scanPro":{"running":null}}' >/dev/null

# 5. 安装
curl -s -X POST $B/update -H 'Content-Type: application/json' \
  -d "{\"action\":\"install\",\"target\":\"app\",\"package\":$PKG}"
# {"action":"install","target":"app","phase":"verifying","fromVersion":"1.0.44.9","toVersion":"1.0.45.0"}
```

每秒轮询一次,端口不再响应时重新探测区间 —— Scan tab 也必须这样做:

```
t=1s   port 29083 verifying
t=3s   port 29083 installing
t=7s   port 29083 restarting
t=9s   port 29083 unreachable
t=11s  port 29083 unreachable → re-probed, found port 29084
t=12s  port 29084 completed percent=100
```

```console
$ curl -s http://127.0.0.1:29084/scanpro/v1/status
{"service":"SprintRayScanService","running":false,"installed":true,"version":"1.0.45.0"}
```

### 模拟器开关

**真实的 SprintRayScanService 没有这些开关。** 它们让 DS 可以按需走到契约的每一个分支。三种设置方式:
`npm run serve` 的参数(下表)、环境文件中的 `SCANPRO_OTA_*`(见 `.env.example`),以及桌面应用开发者模式里的
**OTA simulator** 面板 —— 面板显示实时的 `/update/status`,并可在运行时修改开关。

| 参数 | 作用 |
|---|---|
| `--real-download` | 真正下载 `package.url`(默认:模拟) |
| `--download-speed <MB/s>` | 模拟下载的速度,或真实下载的限速(默认 64) |
| `--simulated-size <MB>` | 模拟下载假装的大小(默认 2150) |
| `--install-time <s>` / `--restart-hold <s>` / `--restart-delay <s>` | `installing` 时长 / `restarting` 可见时长 / 停机时长(4 / 2.5 / 5) |
| `--port-switch` / `--restart-port <n>` | 重启后换到下一个端口 / 换到指定端口 |
| `--fail <spec>` | 强制失败:`[download.\|install.]<phase>:<E_CODE>[@percent]`,phase 为 `downloading` \| `verifying` \| `installing` \| `restarting` —— 如 `downloading:E_DOWNLOAD_FAILED@30`、`install.verifying:E_VERIFY_FAILED`、`installing:E_USER_CANCELLED` |
| `--fail-once <spec>` | 同上,只生效一次,重试即成功 |
| `--stall <spec>` | 冻结进度**和 `updatedAt`**:`[download.\|install.]<phase>[:<s>]`;不带秒数时一直卡住,直到通过 `/_sim` 或面板解除。有进度的阶段卡在 30 % |
| `--bad-signature` | Authenticode 校验失败 → 安装的 `verifying` 阶段报 `E_VERIFY_FAILED` |
| `--version-mismatch` | 安装器"成功",但新服务仍报告旧版本 → `E_INSTALL_FAILED` |
| `--ota-unsupported` | 所有 `POST /update` → `E_UPDATE_UNSUPPORTED` |
| `--no-update-route` | 旧版服务:`/update` 与 `/update/status` 返回 `404` |
| `--inactive-session` | 所有路由返回 `503 E_INACTIVE_SESSION` |
| `--running` / `--not-installed` / `--installed` / `--version <v>` | `/status` 中关于 ScanPro 的报告 |
| `--interrupted-download <resume\|fail>` | 重启后的服务如何处理未完成的下载 |
| `--allow-http-package` | 接受 `http://` 包地址,例如从本机提供的包 |
| `--sim-control` | 挂载下文的控制路由 |
| `--ota-reset` | 启动时清掉所有更新、包和 OTA 安装的版本 |

**控制路由**默认关闭,只有 `--sim-control`(或 `SCANPRO_OTA_SIM_CONTROL=1`)才会打开 —— 一个能改变行为的
回环路由,恰恰是真实服务不该有的东西:

```sh
curl -s $B/_sim                                                  # 开关 + OTA 快照
curl -s -X POST $B/_sim -d '{"failOnce":"installing:E_INSTALL_FAILED","portSwitch":true}'
curl -s -X POST $B/_sim -d '{"stall":null}'                      # 解除卡住
curl -s -X POST $B/_sim/reset                                    # 无更新、无包、回到配置的版本
```

请求体的键与开关相同(`downloadMode`、`downloadBytesPerSec`、`fail`、`failOnce`、`stall`、`portSwitch`、
`restartPort`、`restartDelayMs`、`signatureInvalid`、`versionMismatch`、`unsupported`、`noUpdateRoute`、
`inactiveSession`、`scanPro: { installed, running }` 等)。未知的键返回 `400`,而不是悄悄忽略。
`inactiveSession` 打开时该路由仍可用,以便再把它关掉。

在桌面应用里,窗口本身扮演 ScanPro,所以 `/status` 报 `running: true`,安装会得到 `E_SCAN_ALREADY_RUNNING`,
直到把面板里的 **ScanPro running** 设为 **no** —— 这正是 Scan tab 要处理的"请先关闭 ScanOS 再安装"。

### 超出契约的部分

- **不模拟固件。** `target: "firmware"` → `E_UPDATE_UNSUPPORTED`。
- **模拟下载无法校验 `package.md5`。** 没有真实字节,所以除非强制 `download.verifying:E_VERIFY_FAILED`,否则
  总是通过。需要真实的 MD5 校验时,用 `--real-download` 对一个真实文件下载。安装时仍会对磁盘上留下的占位文件
  重新计算哈希,下载与安装之间被改动会被发现。
- **Authenticode 校验是一个开关**(`--bad-signature`),并不真正校验签名。
- **`restarting` 会先保持可见** 2.5 s 再关闭服务,让 2 s 一次的轮询能看到它。真实服务可能从未报告这个阶段就
  停掉了 —— Scan tab 两种情况都要能处理。
- **中断的下载默认会继续**(由 `--interrupted-download` 选择)。
- **`app.exited { reason: "update" }`** 在*服务*因替换而停止时发送;安装期间 ScanPro 本身不会在运行
  (那是 `E_SCAN_ALREADY_RUNNING`)。
- **`http://` 包地址**按契约拒绝,除非加 `--allow-http-package`。
- **开关与 `/_sim`** 只存在于本模拟器。

## 遥测

以下事件会发往 SprintRay 的遥测接口:

| `eventName` | 何时上报 | `eventData` |
|---|---|---|
| `scanner.connected` | 每次应用被带着病例拉起时 —— 拉起那一刻打时间戳,换取 token 之后发送 | `{ connection, firmwareVersion }` |
| `local_server.port_unavailable` | 端口区间被占满,本机服务未能启动(见[上文](#端口区间被占满时)) | `{ portRangeStart, portRangeEnd, attempted, lastErrorCode }` |
| `app.exited` | 模拟的 [OTA](#ota更新) 安装中,服务停止以便被替换 | `{ reason: "update", uptimeSec }` |
| `app.updated` | 模拟安装结束:成功时在新服务首次启动时发送,失败时在安装步骤失败时发送 | `{ fromVersion, toVersion, durationMs, result, errorCode?, trigger: "sprintray" }` |

**不需要任何额外配置。** 遥测接口就是**同一个 API 网关上的一个路径**,和换取 token、上传走同一把
**`SCANPRO_API_KEY`**,所以地址直接由本应用已经指向的那个 origin 推导出来:

```
${SCANPRO_BASE_URL}/telemetry/SprintRay/events
```

`SCANPRO_BASE_URL` 指向 dev、staging 还是生产,遥测就跟着走 —— 在桌面 UI 里临时改过的 origin 也一样,
那一次运行以 UI 里的为准。key 不对时网关照常返回 `403 {"message":"Forbidden"}`;完全没有 origin 就不发送 ——
事件只记本地日志,应用照常运行。

默认值覆盖不到的情况,有三个选填项:

| | |
|---|---|
| `SCANPRO_TELEMETRY_BRAND` | 你这个集成在路径里的 brand 段,如果 SprintRay 给你登记的名字不是本示例写死的那个(默认 `SprintRay`)。它是受校验的,不是自由文本 —— 服务端不认识的 brand 会被 `400 Unknown telemetry brand` 拒掉 |
| `SCANPRO_TELEMETRY_URL` | 整个地址,如果这条路由以后搬离这个网关 |
| `SCANPRO_TELEMETRY_CHANNEL` | `release` / `beta` / `internal` / `dev` —— 事件来自哪条构建流。本示例固定上报 `dev`,因为它发出的一切都是测试流量;你的应用上报自己的 |

### 每次被拉起上报 `scanner.connected`

被拉起意味着医生开了一个病例、口扫设备就在椅旁,所以本示例把连接上报放在这个时刻。**每次拉起上报一条**,
无论走哪条路径:系统 URL scheme、本机服务的 `POST /scanpro/v1/start`,以及 CLI 处理启动 URL(形式 A)。
常驻的应用再接到一个病例就再报一条,`sessionId` 不变 —— 该 id 标识的是应用的一次运行,不是一个病例。

**拉起那一刻打时间戳,换取 token 之后发送。** 两半刻意分开:

- `occurredAt` 与 `eventId` 在拉起时就定下来,因为那才是口扫设备连上的时刻,而不是批次碰巧发出的时刻;
- `userId` 要等到换取 token 之后才存在。启动 payload 里带的是**一次性 code,不是身份**,而且这个 code
  不能用第二次 —— 所以应用没法自己去查医生是谁,这个 id 只能取自本次流程已经换回来的 access token 的
  `sub` claim。**原样上报**(`auth0|…`,不转小写、不截断):变形过的 id 在 SprintRay 侧关联不到任何人。

有一点需要知道:如果一次拉起的 code 始终没有被换取 —— 开发者皮肤里解码完了却没人点运行,或者换取失败 ——
就不会发送任何事件。这是刻意的取舍:规范(§5.4)宁可没有这条事件,也不要一条归属不到人的事件;而真正会去
扫描的拉起,一定会先换 token。

发送既不会让流程失败,也不会阻塞拉起 —— 遥测接口出问题不会让医生多等,流程直接跨过去。在开发者皮肤里它是
流水线上单独的一步,**整个批次和接口的响应都会出现在请求日志里**,和其它调用一样,你可以直接读到这个应用
究竟发了什么,而不必凭信任。

`scanner.*` 事件要求批次里必须有口扫设备信息(缺失会被拒收,错误码 `SCANNER_REQUIRED`),而本示例没有
真实硬件可问,于是取 `.env` 里配置的值:

```sh
SCANPRO_SCANNER_SERIAL=SPX1-2024-0007391   # 默认 EXAMPLE-<deviceId 前 12 位>
SCANPRO_SCANNER_MODEL=ScanPro S1
SCANPRO_SCANNER_FIRMWARE=1.0.0
SCANPRO_SCANNER_CONNECTION=usb3            # usb2 | usb3 | usbc | wifi | unknown
```

在你自己的应用里,这四个值都应来自刚枚举到的那台设备。序列号最关键:**原样上报,不要做哈希** ——
它是把这批数据关联到具体物理设备的唯一依据;`connection` 请填实际协商的链路速率,而不是插口的物理类型 ——
降级到 USB 2 能解释绝大多数"扫描感觉很慢"的反馈。

### 机器是怎么被标识的

`deviceId` 是操作系统机器标识(macOS `IOPlatformUUID`、Windows `MachineGuid`)的 SHA-256,原始机器标识
不会离开本机;`installationId` 是只生成一次的 uuid。两者都写在 `~/.sprintray-scanpro-example/` 下的
`identity.json`(打包版则在应用的用户数据目录),这正是它们能在重启、升级后保持不变的原因。读不到机器
标识的机器会退化为一个落盘的随机 uuid:对这次安装依然稳定。

## 退出码

- `0` —— 换取 token 且全部上传成功(或 register/status/unregister 命令完成)
- `1` —— 参数错误、缺少环境变量、换取 token / 上传失败,或 `serve` 找不到可用端口

## 构建安装包

```sh
npm run dist:win     # Windows x64 → release/*.exe(NSIS 安装包)
npm run dist:mac     # macOS arm64 → release/*.dmg + *.zip
```

每个平台在各自的操作系统上构建。构建目标:

| 目标 | 架构 | 产物 | 支持范围 |
|---|---|---|---|
| Windows | x64 | NSIS 安装包(`.exe`),用户级安装,无需管理员权限 | Windows 10 1809 及以上 |
| macOS | arm64 | `.dmg` 与 `.zip` | Apple 芯片,macOS 12+ |

打包后的应用会自行向系统注册 `openScanPro` scheme;`.env` 优先从可执行文件同级目录读取,其次是用户数据
目录(UI 的配置面板会显示实际读到的文件路径,字段仍可按次修改)。

### 签名(macOS 上是必需项,不是可选项)

没有 Developer ID 证书时,macOS 构建产物只有 **ad-hoc 签名**,而 macOS 15 及以上的 Gatekeeper 会
**直接拒绝**它。这个失败不给任何线索:应用启动后一秒内就被杀掉,没有弹窗、没有输出 —— 所以从 Finder 打开、
通过 `openScanPro://` 拉起、以及本机服务的 `/start`,看起来全都是"点了没反应"。而直接在终端里跑那个二进制
却是正常的,这正是它容易被误判的原因:

```sh
# 即使应用无法被正常拉起,这样跑依然可以
"/Applications/ScanPro Integration Example.app/Contents/MacOS/ScanPro Integration Example"

# 看看系统到底怎么判定这个构建
spctl -a -vvv -t exec "/Applications/ScanPro Integration Example.app"   # -> rejected
```

要产出测试同学能直接打开的构建,在仓库里配好下面这些 secret,发布流水线会自动完成签名(以及公证):

| Secret | 用途 |
|---|---|
| `MAC_CSC_LINK` | Developer ID Application 证书(`.p12`,base64 编码) |
| `MAC_CSC_KEY_PASSWORD` | 该 `.p12` 的密码 |
| `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | 公证(notarization) |

没配也能构建:流水线会打一条 warning,并在 job 日志里打印实际的签名信息与 Gatekeeper 判定结果。

**一定要跑未签名的构建时**,右键点应用 > **打开**,确认一次;或在**系统设置 > 隐私与安全性**里放行。
在当前版本的 macOS 上,只清除隔离属性已经不够了:

```sh
xattr -dr com.apple.quarantine "/Applications/ScanPro Integration Example.app"
```

Windows 构建同样未签名,但那边 SmartScreen 只是告警 —— 点**更多信息** > **仍要运行**即可。

**发布。** 推送 `v*` tag 会构建两个目标,并把产物挂到该 tag 对应的 GitHub Release 上
(`.github/workflows/release.yml`)。tag 决定应用上报的版本号,因此 `v0.3.0` 构建出的应用
`/status` 会返回 `0.3.0`:

```sh
git tag v0.3.0 && git push origin v0.3.0
```

想只构建、不发布,可手动运行该工作流(**Actions → release → Run workflow**),安装包会作为
workflow artifact 产出。

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
