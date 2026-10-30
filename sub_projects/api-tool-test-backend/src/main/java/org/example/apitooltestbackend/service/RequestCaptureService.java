package org.example.apitooltestbackend.service;

import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.Part;
import org.example.apitooltestbackend.model.CapturedRequest;
import org.example.apitooltestbackend.model.FileInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.multipart.MultipartHttpServletRequest;
import org.springframework.web.servlet.HandlerMapping;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * 把 HttpServletRequest 中用户关心的信息整理成一个可序列化的快照，并打印到日志。
 */
@Service
public class RequestCaptureService {

    private static final Logger log = LoggerFactory.getLogger(RequestCaptureService.class);

    /** 最多读取/返回 64 KiB 的原始请求体，避免日志和响应被超大请求撑爆。 */
    private static final int MAX_BODY_BYTES = 64 * 1024;

    public CapturedRequest capture(HttpServletRequest request) throws IOException {
        String requestId = resolveRequestId(request);

        String contentType = request.getContentType();
        boolean multipart = isMultipart(request, contentType);
        boolean formUrlEncoded = isFormUrlEncoded(contentType);
        Charset charset = resolveCharset(request, contentType);

        Map<String, List<String>> headers = copyHeaders(request);
        Map<String, List<String>> queryParameters = parseQuery(request.getQueryString());
        Map<String, String> pathVariables = copyPathVariables(request);
        Map<String, List<String>> parameters = copyParameters(request.getParameterMap());

        Map<String, List<String>> formFields = new LinkedHashMap<>();
        List<FileInfo> files = new ArrayList<>();
        if (multipart) {
            // 表单字段也可能出现在 URL 查询串里，这里统一放在 parameters/formFields 中，
            // queryParameters 仍保留纯 URL 查询参数，便于对照。
            formFields.putAll(parameters);
            collectMultipartFiles(request, formFields, files, charset);
        } else if (formUrlEncoded) {
            formFields.putAll(parameters);
        }

        String body = null;
        long bodySize = 0;
        boolean bodyTruncated = false;
        if (!multipart && !formUrlEncoded && isTextual(contentType)) {
            BodyRead result = readBody(request, charset);
            body = result.text();
            bodySize = result.size();
            bodyTruncated = result.truncated();
        }

        CapturedRequest captured = new CapturedRequest(
                requestId,
                request.getMethod(),
                buildFullUrl(request),
                request.getRequestURI(),
                request.getQueryString(),
                queryParameters,
                pathVariables,
                headers,
                parameters,
                formFields,
                files,
                contentType,
                charset.name(),
                request.getContentLengthLong(),
                request.getRemoteAddr(),
                body,
                bodySize,
                bodyTruncated
        );

        logRequest(captured);
        return captured;
    }

    private String resolveRequestId(HttpServletRequest request) {
        String header = request.getHeader("X-Request-Id");
        if (header != null && !header.isBlank() && header.length() <= 128) {
            return header.trim();
        }
        return UUID.randomUUID().toString();
    }

    private String buildFullUrl(HttpServletRequest request) {
        String url = request.getRequestURL().toString();
        String query = request.getQueryString();
        return query == null || query.isBlank() ? url : url + "?" + query;
    }

    private Map<String, List<String>> copyHeaders(HttpServletRequest request) {
        Map<String, List<String>> result = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        Enumeration<String> names = request.getHeaderNames();
        if (names == null) {
            return result;
        }
        while (names.hasMoreElements()) {
            String name = names.nextElement();
            result.put(name, List.copyOf(Collections.list(request.getHeaders(name))));
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private Map<String, String> copyPathVariables(HttpServletRequest request) {
        Object value = request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE);
        if (!(value instanceof Map<?, ?> variables) || variables.isEmpty()) {
            return Map.of();
        }
        Map<String, String> result = new LinkedHashMap<>();
        variables.forEach((key, pathValue) ->
                result.put(String.valueOf(key), pathValue == null ? "" : String.valueOf(pathValue)));
        return result;
    }

    private Map<String, List<String>> copyParameters(Map<String, String[]> parameterMap) {
        Map<String, List<String>> result = new LinkedHashMap<>();
        parameterMap.forEach((key, values) -> {
            List<String> list = new ArrayList<>();
            if (values != null) {
                Collections.addAll(list, values);
            }
            result.put(key, List.copyOf(list));
        });
        return result;
    }

    /**
     * 只解析 URL 中的查询串，不依赖 request.getParameterMap()，
     * 这样表单字段和 URL 查询参数可以分开展示。
     */
    private Map<String, List<String>> parseQuery(String queryString) {
        if (queryString == null || queryString.isBlank()) {
            return Map.of();
        }
        Map<String, List<String>> result = new LinkedHashMap<>();
        for (String pair : queryString.split("&")) {
            if (pair.isEmpty()) {
                continue;
            }
            int index = pair.indexOf('=');
            String rawName = index >= 0 ? pair.substring(0, index) : pair;
            String rawValue = index >= 0 ? pair.substring(index + 1) : "";
            String name = decode(rawName);
            String value = decode(rawValue);
            result.computeIfAbsent(name, ignored -> new ArrayList<>()).add(value);
        }
        result.replaceAll((key, values) -> List.copyOf(values));
        return result;
    }

    private String decode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException ex) {
            return value;
        }
    }

    private boolean isMultipart(HttpServletRequest request, String contentType) {
        return request instanceof MultipartHttpServletRequest
                || (contentType != null
                && contentType.toLowerCase(Locale.ROOT).trim().startsWith("multipart/"));
    }

    private boolean isFormUrlEncoded(String contentType) {
        return contentType != null
                && contentType.toLowerCase(Locale.ROOT).trim()
                .startsWith("application/x-www-form-urlencoded");
    }

    private boolean isTextual(String contentType) {
        if (contentType == null || contentType.isBlank()) {
            return true;
        }
        String value = contentType.toLowerCase(Locale.ROOT);
        return value.startsWith("text/")
                || value.contains("json")
                || value.contains("xml")
                || value.contains("javascript")
                || value.contains("x-www-form-urlencoded")
                || value.contains("graphql")
                || value.contains("yaml");
    }

    private BodyRead readBody(HttpServletRequest request, Charset charset) throws IOException {
        long declaredLength = request.getContentLengthLong();
        try (InputStream inputStream = request.getInputStream()) {
            byte[] bytes = inputStream.readNBytes(MAX_BODY_BYTES + 1);
            boolean truncated = bytes.length > MAX_BODY_BYTES || declaredLength > MAX_BODY_BYTES;
            int readable = Math.min(bytes.length, MAX_BODY_BYTES);
            String text = new String(bytes, 0, readable, charset);
            long size = declaredLength >= 0 ? declaredLength : bytes.length;
            return new BodyRead(text, size, truncated);
        }
    }

    private Charset resolveCharset(HttpServletRequest request, String contentType) {
        String encoding = request.getCharacterEncoding();
        if (encoding != null && !encoding.isBlank()) {
            try {
                return Charset.forName(encoding.trim());
            } catch (RuntimeException ignored) {
                // 继续尝试从 Content-Type 中解析
            }
        }
        if (contentType != null) {
            for (String part : contentType.split(";")) {
                String item = part.trim();
                if (item.regionMatches(true, 0, "charset=", 0, 8)) {
                    String name = item.substring(8).trim().replace("\"", "");
                    try {
                        return Charset.forName(name);
                    } catch (RuntimeException ignored) {
                        // 使用默认 UTF-8
                    }
                }
            }
        }
        return StandardCharsets.UTF_8;
    }

    private void collectMultipartFiles(
            HttpServletRequest request,
            Map<String, List<String>> formFields,
            List<FileInfo> files,
            Charset charset
    ) {
        if (request instanceof MultipartHttpServletRequest multipartRequest) {
            for (Map.Entry<String, List<MultipartFile>> entry
                    : multipartRequest.getMultiFileMap().entrySet()) {
                for (MultipartFile file : entry.getValue()) {
                    String filename = file.getOriginalFilename();
                    if (filename == null || filename.isBlank()) {
                        continue;
                    }
                    files.add(new FileInfo(
                            entry.getKey(),
                            filename,
                            file.getContentType(),
                            file.getSize()
                    ));
                }
            }
            return;
        }

        // 理论上 Boot 会自动配置 MultipartResolver；这里保留对原生 Part 的兜底。
        try {
            for (Part part : request.getParts()) {
                String filename = part.getSubmittedFileName();
                if (filename != null && !filename.isBlank()) {
                    files.add(new FileInfo(
                            part.getName(),
                            filename,
                            part.getContentType(),
                            part.getSize()
                    ));
                } else if (!formFields.containsKey(part.getName())) {
                    try (InputStream inputStream = part.getInputStream()) {
                        byte[] bytes = inputStream.readNBytes(MAX_BODY_BYTES + 1);
                        int readable = Math.min(bytes.length, MAX_BODY_BYTES);
                        formFields.computeIfAbsent(part.getName(), ignored -> new ArrayList<>())
                                .add(new String(bytes, 0, readable, charset));
                    }
                }
            }
        } catch (IOException | ServletException | IllegalStateException ex) {
            log.warn("解析 multipart 内容失败: {}", ex.getMessage());
        }
    }

    private void logRequest(CapturedRequest captured) {
        String body = captured.body() == null ? "<未按文本捕获，请查看 formFields / files>" : captured.body();
        if (captured.bodyTruncated()) {
            body = body + "\n... <请求体超过 " + MAX_BODY_BYTES + " 字节，已截断>";
        }
        log.info("""

                ==================== API REQUEST ====================
                requestId : {}
                method    : {}
                url       : {}
                path      : {}
                remote    : {}
                type      : {} (charset={})
                headers   : {}
                query     : {}
                pathVars  : {}
                params    : {}
                form      : {}
                files     : {}
                body      : {}
                =====================================================
                """,
                captured.requestId(),
                captured.method(),
                captured.url(),
                captured.path(),
                captured.remoteAddress(),
                captured.contentType(),
                captured.characterEncoding(),
                captured.headers(),
                captured.queryParameters(),
                captured.pathVariables(),
                captured.parameters(),
                captured.formFields(),
                captured.files(),
                body);
    }

    private record BodyRead(String text, long size, boolean truncated) {
    }
}
