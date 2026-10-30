package org.example.apitooltestbackend.model;

import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;

/**
 * 所有接口共用的响应包装。
 *
 * @param success   业务是否成功
 * @param code      业务/HTTP 状态码
 * @param message   面向前端或调用方的提示
 * @param requestId 本次请求的追踪 ID，同时写入响应头 X-Request-Id
 * @param serverTime 服务端时间（ISO-8601）
 * @param data      实际响应数据
 */
public record ApiResponse<T>(
        boolean success,
        int code,
        String message,
        String requestId,
        String serverTime,
        T data
) {

    private static final DateTimeFormatter TIME_FORMATTER = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    public static <T> ApiResponse<T> ok(String message, String requestId, T data) {
        return new ApiResponse<>(true, 200, message, requestId, now(), data);
    }

    public static <T> ApiResponse<T> of(boolean success, int code, String message, String requestId, T data) {
        return new ApiResponse<>(success, code, message, requestId, now(), data);
    }

    private static String now() {
        return OffsetDateTime.now().format(TIME_FORMATTER);
    }
}
