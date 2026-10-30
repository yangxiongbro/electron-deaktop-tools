# API Tool Test Backend

一个用于测试 API 请求工具（Postman、Apifox、Hoppscotch、Electron 自研工具等）的 Spring Boot 回显后端。

接口会接收并打印 URL 查询参数、路径参数、请求头、JSON/表单/纯文本请求体以及 multipart 文件信息，然后把完整请求快照和一段服务端响应一起返回，方便核对工具发出的请求是否符合预期。

## 特性

- 支持 `GET`、`POST`、`PUT`、`DELETE`、`PATCH` 常用请求方法
- 同时支持 `application/json`、`multipart/form-data`、`application/x-www-form-urlencoded`、`text/plain`、XML 等请求体
- multipart 支持普通字段和多个文件，文件只读取元信息，不落盘
- 支持 URL 查询参数、路径参数（如 `/api/test/put/1001`）、自定义请求头
- 文件导出测试：支持 text、json、csv、binary，以及中文文件名、RFC 5987、CSV BOM 和指定二进制大小
- 每个请求打印完整内容到控制台，并在响应中返回 `request` 快照
- 自动返回 `X-Request-Id` 响应头，便于日志对照
- 全局 CORS，Electron/浏览器调试页可直接调用
- 内置一个零依赖的 Web 测试控制台：<http://localhost:8080/>
- 提供可直接运行的 HTTP 集成测试

## 环境要求

- JDK 17+
- Maven 3.9+（需在本机自行安装，仓库不包含 Maven Wrapper；能执行 `mvn -v` 即可）

## 启动

```bash
mvn spring-boot:run
```

启动后：

- 测试控制台：<http://localhost:8080/>
- API 根路径：`http://localhost:8080/api`

打包运行：

```bash
mvn clean package
java -jar target/api-tool-test-backend-0.0.1-SNAPSHOT.jar
```

如需修改端口：

```bash
mvn spring-boot:run -Dspring-boot.run.arguments=--server.port=9090
```

或设置环境变量 `SERVER_PORT=9090`。

## 接口一览

| 方法 | 地址 | 说明 |
| --- | --- | --- |
| GET | `/api/test/get` | 回显查询参数、请求头；也支持 GET 请求体 |
| POST | `/api/test/post` | 回显 JSON、form-data、urlencoded、纯文本等请求体 |
| PUT | `/api/test/put`、`/api/test/put/{id}` | 回显路径参数、查询参数、请求体 |
| DELETE | `/api/test/delete`、`/api/test/delete/{id}` | 回显路径参数、查询参数；也支持请求体 |
| PATCH | `/api/test/patch`、`/api/test/patch/{id}` | 回显路径参数、查询参数、请求体 |
| 任意 | `/api/echo`、`/api/echo/**` | 通用 Echo，支持以上所有方法 |
| GET | `/api/test/status/{code}` | 返回指定 HTTP 状态码，便于测试错误处理 |
| GET | `/api/test/export` | 文件导出测试，支持 text、json、csv、binary |

> `/api/echo/**` 的路径可以任意写，例如 `/api/echo/users/1001`，服务端会原样回显路径。

## 快速调用示例

### 1. GET + URL 查询参数

```bash
curl "http://localhost:8080/api/test/get?name=张三&tag=api&tag=test"
```

### 2. POST JSON

```bash
curl -X POST "http://localhost:8080/api/test/post?source=curl" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"张三\",\"age\":18,\"tags\":[\"api\",\"test\"]}"
```

PowerShell 中建议使用 `curl.exe`，避免 `curl` 被解析成 `Invoke-WebRequest`。

### 3. POST multipart/form-data（字段 + 文件）

```bash
curl -X POST "http://localhost:8080/api/test/post" \
  -F "name=张三" \
  -F "message=hello form-data" \
  -F "file=@C:\path\to\hello.txt"
```

多个文件可以重复使用 `-F "file=@..."`。

### 4. POST x-www-form-urlencoded

```bash
curl -X POST "http://localhost:8080/api/test/post" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "name=张三&age=18"
```

### 5. PUT + 路径参数 + 查询参数 + JSON

```bash
curl -X PUT "http://localhost:8080/api/test/put/1001?operator=tester" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"updated\",\"enabled\":true}"
```

### 6. DELETE

```bash
curl -X DELETE "http://localhost:8080/api/test/delete/1001?reason=cleanup"
```

### 7. 通用 Echo + PATCH

```bash
curl -X PATCH "http://localhost:8080/api/echo/demo?mode=echo" \
  -H "Content-Type: text/plain" \
  -d "hello echo"
```

### 8. 指定状态码

```bash
curl -i "http://localhost:8080/api/test/status/418"
```

### 9. 文件导出

文本文件：

```bash
curl -o export.txt "http://localhost:8080/api/test/export?format=text&filename=export.txt"
```

JSON 文件：

```bash
curl -o export.json "http://localhost:8080/api/test/export?format=json&filename=导出测试.json"
```

CSV 文件（带 UTF-8 BOM，方便 Excel 打开）：

```bash
curl -o export.csv "http://localhost:8080/api/test/export?format=csv&filename=导出测试.csv"
```

二进制文件（指定大小，单位字节，最大 10 MiB）：

```bash
curl -o export.bin "http://localhost:8080/api/test/export?format=binary&size=1048576&filename=demo.bin"
```

查看下载响应头：

```bash
curl -i "http://localhost:8080/api/test/export?format=text&filename=export.txt"
```

### 10. 查看响应头中的请求 ID

```bash
curl -i "http://localhost:8080/api/test/get?name=Alice"
```

响应头会包含：

```text
X-Request-Id: 8f0c...
X-Server-Name: api-tool-test-backend
```

也可以主动传入 `X-Request-Id` 请求头，服务端会沿用它。

## 文件导出测试接口

`GET /api/test/export` 用于验证 API 工具是否能够正确处理附件下载、文件名、二进制内容和文件大小。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `format` | `text` | 导出格式：`text`、`json`、`csv`、`binary` |
| `filename` | `api-export-测试.<ext>` | 下载文件名，支持中文；没有扩展名时自动补全 |
| `size` | `1024` | 仅 `binary` 使用，文件字节数，范围 `0` 到 `10485760` |

格式说明：

| format | Content-Type | 内容 |
| --- | --- | --- |
| `text` | `text/plain;charset=UTF-8` | 中文和英文示例文本 |
| `json` | `application/json;charset=UTF-8` | 带中文的格式化 JSON |
| `csv` | `text/csv;charset=UTF-8` | 带 UTF-8 BOM 的 CSV，包含逗号字段 |
| `binary` | `application/octet-stream` | 指定大小的确定性二进制内容 |

响应头示例：

```text
Content-Type: text/plain;charset=UTF-8
Content-Disposition: attachment; filename="export.txt"; filename*=UTF-8''export.txt
Content-Length: 210
X-Export-Format: text
X-Export-Size: 210
X-Request-Id: 8f0c...
X-Server-Name: api-tool-test-backend
```

中文文件名会通过 RFC 5987 的 `filename*=UTF-8''...` 传递，同时保留一个 ASCII 的 `filename` 回退值，兼容不同 API 工具。`Content-Disposition`、`X-Export-*` 已加入 CORS 暴露头，浏览器/Electron 渲染进程可以读取。

文件名中的 `\ / : * ? " < > |` 和控制字符会被替换为 `_`，长度限制为 120 个字符。

## 响应结构

回显接口使用统一包装（文件导出接口直接返回文件流，不使用该包装）：

```json
{
  "success": true,
  "code": 200,
  "message": "POST 请求成功",
  "requestId": "6f1c2d3e-...",
  "serverTime": "2026-10-31T01:00:00+08:00",
  "data": {
    "request": {
      "requestId": "6f1c2d3e-...",
      "method": "POST",
      "url": "http://localhost:8080/api/test/post?source=curl",
      "path": "/api/test/post",
      "queryString": "source=curl",
      "queryParameters": {
        "source": ["curl"]
      },
      "pathVariables": {},
      "headers": {
        "Content-Type": ["application/json"],
        "Host": ["localhost:8080"]
      },
      "parameters": {
        "source": ["curl"]
      },
      "formFields": {},
      "files": [],
      "contentType": "application/json",
      "characterEncoding": "UTF-8",
      "contentLength": 39,
      "remoteAddress": "127.0.0.1",
      "body": "{\"name\":\"张三\",\"age\":18}",
      "bodySize": 39,
      "bodyTruncated": false
    },
    "response": {
      "message": "POST 请求成功",
      "note": "支持 application/json、multipart/form-data、...",
      "method": "POST",
      "path": "/api/test/post",
      "requestId": "6f1c2d3e-...",
      "serverTime": "2026-10-31T01:00:00+08:00",
      "hint": "服务端已把完整请求内容打印到控制台；你可以在返回的 request 字段中复核。"
    }
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `method` / `url` / `path` | 请求方法、完整 URL、路径 |
| `queryString` / `queryParameters` | 原始查询串和解析后的查询参数 |
| `pathVariables` | `{id}` 这类路径变量 |
| `headers` | 全部请求头（大小写不敏感排序） |
| `parameters` | Servlet 容器解析出的全部参数，GET 时通常等于查询参数，表单请求时包含表单字段 |
| `formFields` | `multipart/form-data` 或 `x-www-form-urlencoded` 的表单字段；基于 Servlet 参数视图，若 URL 查询参数与表单字段同名，也可能一并出现，可结合 `queryParameters` 对照 |
| `files` | 上传文件的字段名、原始文件名、Content-Type、字节数 |
| `body` | 原始文本请求体；multipart 和 urlencoded 时为 `null`，内容看 `formFields` / `files` |
| `bodySize` / `bodyTruncated` | 请求体字节数；超过 64 KiB 时只截取前 64 KiB |
| `characterEncoding` | 服务端解析请求体时使用的字符集 |

## 服务端日志

每个请求都会在控制台打印类似内容：

```text
==================== API REQUEST ====================
requestId : 6f1c2d3e-...
method    : POST
url       : http://localhost:8080/api/test/post?source=curl
path      : /api/test/post
remote    : 127.0.0.1
type      : application/json; charset=UTF-8 (charset=UTF-8)
headers   : {Accept=[*/*], Content-Type=[application/json; charset=UTF-8], ...}
query     : {source=[curl]}
pathVars  : {}
params    : {source=[curl]}
form      : {}
files     : []
body      : {"name":"张三","age":18}
=====================================================
```

> 日志会包含请求头，若使用真实 Token 测试请注意不要泄露日志。

## 配置说明

主要配置位于 `src/main/resources/application.properties`：

```properties
server.port=8080
server.servlet.encoding.charset=UTF-8
spring.servlet.multipart.max-file-size=20MB
spring.servlet.multipart.max-request-size=50MB
```

CORS 在 `src/main/java/org/example/apitooltestbackend/config/WebConfig.java` 中配置，当前允许所有来源和方法，仅适合本地测试环境。部署到公网前请收紧 `allowedOriginPatterns`。

## 项目结构

```text
src/main/java/org/example/apitooltestbackend
├── ApiToolTestBackendApplication.java   启动类
├── config/WebConfig.java                CORS 配置
├── controller/ApiTestController.java    回显测试接口
├── controller/FileExportController.java 文件导出测试接口
├── model/ApiResponse.java               统一响应包装
├── model/CapturedRequest.java           请求快照
├── model/FileInfo.java                  上传文件元信息
└── service/RequestCaptureService.java   请求捕获、解析、日志
src/main/resources
├── application.properties
├── banner.txt
└── static/index.html                    内置测试控制台
src/test/java/...                        HTTP 集成测试
api-tool-test.http                       IDE HTTP Client 示例
```

## 运行测试

```bash
mvn test
```

集成测试会启动随机端口，覆盖 GET 查询参数、POST JSON、multipart 文件、PUT 路径参数、DELETE、PATCH Echo、指定状态码，以及 text/json/csv/binary 四种文件导出和非法格式校验。

## 内置控制台

启动后访问 <http://localhost:8080/>，可以在页面中切换方法、填写 Query/Headers/Body，支持 JSON、urlencoded、form-data 和文件上传，并直接查看状态码、耗时、响应头和格式化后的响应体。页面不依赖任何 CDN 或前端构建工具。

## 已知边界

- 为了统一处理多种 Content-Type，接口没有使用 `@RequestBody`，而是直接读取 `HttpServletRequest`。
- `multipart/form-data` 和 `application/x-www-form-urlencoded` 的请求体不会被再次读取，内容在 `formFields`/`files` 中展示。
- 文本请求体最大读取 64 KiB，避免日志过大；文件仅读取元信息，不保存内容。
- 文件导出接口的二进制大小上限为 10 MiB；导出内容在内存中生成，不写入磁盘。
- 浏览器原生 `fetch` 不允许 GET/HEAD 携带请求体，如需测试 GET body，请使用专业 API 工具或 curl。
