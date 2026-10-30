package org.example.apitooltestbackend.controller;

import jakarta.servlet.http.HttpServletRequest;
import org.example.apitooltestbackend.model.ApiResponse;
import org.example.apitooltestbackend.model.CapturedRequest;
import org.example.apitooltestbackend.service.RequestCaptureService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.Set;

/**
 * 文件导出测试接口。
 *
 * <p>用于验证 API 工具是否能正确处理：
 * 附件下载、Content-Disposition、中文文件名、文本/CSV/JSON/二进制内容和文件大小。</p>
 */
@RestController
@RequestMapping("/api/test")
public class FileExportController {

    private static final Logger log = LoggerFactory.getLogger(FileExportController.class);

    private static final DateTimeFormatter TIME_FORMATTER = DateTimeFormatter.ISO_OFFSET_DATE_TIME;
    private static final Set<String> SUPPORTED_FORMATS = Set.of("text", "json", "csv", "binary");
    private static final String DEFAULT_BINARY_SIZE = "1024";
    private static final int MAX_BINARY_SIZE = 10 * 1024 * 1024;

    private final RequestCaptureService captureService;

    public FileExportController(RequestCaptureService captureService) {
        this.captureService = captureService;
    }

    /**
     * 生成并下载一个测试文件。
     *
     * @param format   text、json、csv、binary，默认 text
     * @param filename 自定义下载文件名，支持中文；不传时使用默认文件名
     * @param size     binary 格式的文件大小（字节），默认 1024，最大 10 MiB
     */
    @GetMapping("/export")
    public ResponseEntity<?> export(
            @RequestParam(defaultValue = "text") String format,
            @RequestParam(required = false) String filename,
            @RequestParam(defaultValue = DEFAULT_BINARY_SIZE) int size,
            HttpServletRequest request
    ) throws IOException {
        CapturedRequest captured = captureService.capture(request);
        String normalizedFormat = format == null
                ? "text"
                : format.trim().toLowerCase(Locale.ROOT);

        if (!SUPPORTED_FORMATS.contains(normalizedFormat)) {
            log.warn("拒绝不支持的导出格式: format={}, requestId={}",
                    format, captured.requestId());
            return ResponseEntity.badRequest().body(ApiResponse.of(
                    false,
                    400,
                    "不支持的导出格式：" + format + "，可选值为 text、json、csv、binary",
                    captured.requestId(),
                    null
            ));
        }

        if ("binary".equals(normalizedFormat) && (size < 0 || size > MAX_BINARY_SIZE)) {
            log.warn("拒绝非法的二进制文件大小: size={}, requestId={}",
                    size, captured.requestId());
            return ResponseEntity.badRequest().body(ApiResponse.of(
                    false,
                    400,
                    "size 必须在 0 到 " + MAX_BINARY_SIZE + " 之间",
                    captured.requestId(),
                    null
            ));
        }

        ExportFile exportFile = createExportFile(normalizedFormat, size, captured.url());
        String safeFilename = sanitizeFilename(filename, exportFile.defaultFilename());

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(exportFile.mediaType());
        headers.setContentLength(exportFile.content().length);
        headers.set(HttpHeaders.CONTENT_DISPOSITION, buildContentDisposition(safeFilename, normalizedFormat));
        headers.set(HttpHeaders.CACHE_CONTROL, "no-store");
        headers.set("X-Export-Format", normalizedFormat);
        headers.set("X-Export-Size", String.valueOf(exportFile.content().length));
        headers.set("X-Request-Id", captured.requestId());
        headers.set("X-Server-Name", "api-tool-test-backend");

        log.info("导出文件: format={}, filename={}, contentType={}, bytes={}, requestId={}",
                normalizedFormat,
                safeFilename,
                exportFile.mediaType(),
                exportFile.content().length,
                captured.requestId());

        return new ResponseEntity<>(exportFile.content(), headers, HttpStatus.OK);
    }

    private ExportFile createExportFile(String format, int size, String requestUrl) {
        String now = OffsetDateTime.now().format(TIME_FORMATTER);
        return switch (format) {
            case "json" -> new ExportFile(
                    """
                            {
                              "message": "API 文件导出测试成功",
                              "exportedAt": "%s",
                              "format": "json",
                              "sourceUrl": "%s",
                              "items": [
                                {"id": 1, "name": "张三", "role": "tester"},
                                {"id": 2, "name": "Alice", "role": "developer"},
                                {"id": 3, "name": "李四", "role": "operator"}
                              ]
                            }
                            """.formatted(now, requestUrl).getBytes(StandardCharsets.UTF_8),
                    MediaType.parseMediaType("application/json;charset=UTF-8"),
                    "api-export-测试.json"
            );
            case "csv" -> new ExportFile(
                    ("\uFEFFid,name,role,note\r\n"
                            + "1,张三,测试工程师,\"包含,逗号的内容\"\r\n"
                            + "2,Alice,Developer,\"English content\"\r\n"
                            + "3,李四,运维,\"中文与 English 混合\"\r\n")
                            .getBytes(StandardCharsets.UTF_8),
                    MediaType.parseMediaType("text/csv;charset=UTF-8"),
                    "api-export-测试.csv"
            );
            case "binary" -> new ExportFile(
                    createBinaryContent(size),
                    MediaType.APPLICATION_OCTET_STREAM,
                    "api-export-测试.bin"
            );
            default -> new ExportFile(
                    ("""
                            API 文件导出测试
                            ==================
                            导出时间：%s
                            请求地址：%s
                            中文 / English / 1234567890
                            如果 API 工具能保存这个文件，说明下载与落盘流程正常。
                            """.formatted(now, requestUrl)).getBytes(StandardCharsets.UTF_8),
                    MediaType.parseMediaType("text/plain;charset=UTF-8"),
                    "api-export-测试.txt"
            );
        };
    }

    private byte[] createBinaryContent(int size) {
        int length = size < 0 ? 0 : size;
        byte[] content = new byte[length];
        for (int i = 0; i < length; i++) {
            content[i] = (byte) ((i * 31 + 17) & 0xFF);
        }
        return content;
    }

    /**
     * 去掉路径分隔符、Windows 非法字符和控制字符，防止下载文件名造成异常。
     * 没有扩展名时补一个与格式对应的扩展名。
     */
    private String sanitizeFilename(String rawFilename, String defaultFilename) {
        String filename = rawFilename == null || rawFilename.isBlank()
                ? defaultFilename
                : rawFilename.trim();

        filename = filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        filename = filename.replaceAll("^[.\\s]+", "");
        if (filename.isBlank()) {
            filename = defaultFilename;
        }
        if (filename.lastIndexOf('.') <= 0 || filename.endsWith(".")) {
            filename += extensionFor(defaultFilename);
        }
        if (filename.length() > 120) {
            int dot = filename.lastIndexOf('.');
            String extension = dot > 0 && filename.length() - dot <= 12
                    ? filename.substring(dot)
                    : "";
            filename = filename.substring(0, Math.max(1, 120 - extension.length())) + extension;
        }
        return filename;
    }

    private String extensionFor(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot >= 0 ? filename.substring(dot) : "";
    }

    /**
     * 同时输出 ASCII filename 和 RFC 5987 的 filename*，兼容旧客户端和中文文件名。
     */
    private String buildContentDisposition(String filename, String format) {
        String encoded = URLEncoder.encode(filename, StandardCharsets.UTF_8)
                .replace("+", "%20");
        String asciiFallback = filename.chars().allMatch(ch -> ch >= 0x20 && ch <= 0x7E)
                ? filename.replace("\"", "_")
                : "export" + extensionFor(filename);
        return "attachment; filename=\"" + asciiFallback + "\"; filename*=UTF-8''" + encoded;
    }

    private record ExportFile(byte[] content, MediaType mediaType, String defaultFilename) {
    }
}
