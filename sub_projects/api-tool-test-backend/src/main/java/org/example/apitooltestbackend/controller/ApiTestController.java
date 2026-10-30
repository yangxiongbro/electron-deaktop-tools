package org.example.apitooltestbackend.controller;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.example.apitooltestbackend.model.ApiResponse;
import org.example.apitooltestbackend.model.CapturedRequest;
import org.example.apitooltestbackend.service.RequestCaptureService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 供 API 调试工具使用的测试控制器。
 *
 * <p>所有方法都直接读取 HttpServletRequest，因此同一个接口可以同时处理
 * JSON、表单、multipart 文件、纯文本等请求体，而不需要为每种 Content-Type
 * 写一个 @RequestBody 方法。</p>
 */
@RestController
@RequestMapping("/api")
public class ApiTestController {

    private static final DateTimeFormatter TIME_FORMATTER = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    private final RequestCaptureService captureService;

    public ApiTestController(RequestCaptureService captureService) {
        this.captureService = captureService;
    }

    @GetMapping("/test/get")
    public ApiResponse<Map<String, Object>> get(
            HttpServletRequest request,
            HttpServletResponse response
    ) throws IOException {
        return respond(request, response,
                "GET 请求成功",
                "已接收 URL 查询参数和请求头；GET 也可以携带请求体，服务端同样会尝试捕获。");
    }

    @PostMapping("/test/post")
    public ApiResponse<Map<String, Object>> post(
            HttpServletRequest request,
            HttpServletResponse response
    ) throws IOException {
        return respond(request, response,
                "POST 请求成功",
                "支持 application/json、multipart/form-data、application/x-www-form-urlencoded、text/plain 等请求体。");
    }

    @PutMapping({"/test/put", "/test/put/{id}"})
    public ApiResponse<Map<String, Object>> put(
            HttpServletRequest request,
            HttpServletResponse response
    ) throws IOException {
        return respond(request, response,
                "PUT 请求成功",
                "可以在路径中携带 id，例如 /api/test/put/1001，同时支持查询参数和请求体。");
    }

    @DeleteMapping({"/test/delete", "/test/delete/{id}"})
    public ApiResponse<Map<String, Object>> delete(
            HttpServletRequest request,
            HttpServletResponse response
    ) throws IOException {
        return respond(request, response,
                "DELETE 请求成功",
                "DELETE 也可以携带查询参数和请求体，适合测试不同 API 工具的行为。");
    }

    @PatchMapping({"/test/patch", "/test/patch/{id}"})
    public ApiResponse<Map<String, Object>> patch(
            HttpServletRequest request,
            HttpServletResponse response
    ) throws IOException {
        return respond(request, response,
                "PATCH 请求成功",
                "PATCH 与 PUT 类似，服务端会原样捕获请求体供调试。");
    }

    /**
     * 通用 Echo 接口：任意常见 HTTP 方法和任意子路径都可以调用。
     * 适合在 API 工具里把请求地址临时改成 /api/echo/... 进行抓包。
     */
    @RequestMapping(
            value = {"/echo", "/echo/**"},
            method = {
                    RequestMethod.GET,
                    RequestMethod.POST,
                    RequestMethod.PUT,
                    RequestMethod.DELETE,
                    RequestMethod.PATCH
            }
    )
    public ApiResponse<Map<String, Object>> echo(
            HttpServletRequest request,
            HttpServletResponse response
    ) throws IOException {
        return respond(request, response,
                "Echo 请求成功",
                "通用 Echo 接口支持 GET/POST/PUT/DELETE/PATCH，任意子路径均可访问。");
    }

    /**
     * 返回指定的 HTTP 状态码，便于测试 API 工具对 4xx/5xx 的处理。
     */
    @GetMapping("/test/status/{code}")
    public ResponseEntity<ApiResponse<Map<String, Object>>> status(
            @PathVariable int code,
            HttpServletRequest request,
            HttpServletResponse response
    ) throws IOException {
        int httpStatus = code < 200 || code > 599 ? 400 : code;
        CapturedRequest captured = captureService.capture(request);
        response.setHeader("X-Request-Id", captured.requestId());

        Map<String, Object> echo = new LinkedHashMap<>();
        echo.put("requestedStatus", code);
        echo.put("actualStatus", httpStatus);
        echo.put("requestId", captured.requestId());
        echo.put("hint", httpStatus >= 200 && httpStatus < 400
                ? "这是一个成功状态码。"
                : "这是一个错误状态码，可用于测试工具的错误展示。");

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("request", captured);
        data.put("response", echo);

        boolean success = httpStatus >= 200 && httpStatus < 400;
        String message = "返回指定状态码 " + httpStatus;
        return ResponseEntity.status(httpStatus)
                .body(ApiResponse.of(success, httpStatus, message, captured.requestId(), data));
    }

    private ApiResponse<Map<String, Object>> respond(
            HttpServletRequest request,
            HttpServletResponse response,
            String message,
            String note
    ) throws IOException {
        CapturedRequest captured = captureService.capture(request);
        response.setHeader("X-Request-Id", captured.requestId());
        response.setHeader("X-Server-Name", "api-tool-test-backend");

        Map<String, Object> echo = new LinkedHashMap<>();
        echo.put("message", message);
        echo.put("note", note);
        echo.put("method", captured.method());
        echo.put("path", captured.path());
        echo.put("requestId", captured.requestId());
        echo.put("serverTime", OffsetDateTime.now().format(TIME_FORMATTER));
        echo.put("hint", "服务端已把完整请求内容打印到控制台；你可以在返回的 request 字段中复核。");

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("request", captured);
        data.put("response", echo);
        return ApiResponse.ok(message, captured.requestId(), data);
    }
}
