package org.example.apitooltestbackend.model;

/**
 * multipart/form-data 中接收到的文件元信息。
 * 服务端只读取元信息，不把文件落盘。
 */
public record FileInfo(
        String fieldName,
        String originalFilename,
        String contentType,
        long size
) {
}
