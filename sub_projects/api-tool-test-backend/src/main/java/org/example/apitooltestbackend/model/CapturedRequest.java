package org.example.apitooltestbackend.model;

import java.util.List;
import java.util.Map;

/**
 * 一次 HTTP 请求的完整快照，作为响应中的 request 字段返回。
 *
 * <p>body 为原始文本；multipart/form-data 和
 * application/x-www-form-urlencoded 的内容分别放在 formFields、files 中。
 * 非文本类型（如 application/octet-stream）不会尝试解码，body 为 null。</p>
 */
public record CapturedRequest(
        String requestId,
        String method,
        String url,
        String path,
        String queryString,
        Map<String, List<String>> queryParameters,
        Map<String, String> pathVariables,
        Map<String, List<String>> headers,
        Map<String, List<String>> parameters,
        Map<String, List<String>> formFields,
        List<FileInfo> files,
        String contentType,
        String characterEncoding,
        long contentLength,
        String remoteAddress,
        String body,
        long bodySize,
        boolean bodyTruncated
) {
}
