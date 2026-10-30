package org.example.apitooltestbackend;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 通过真实 HTTP 端口验证各个测试接口，避免只测试 Spring 上下文。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ApiToolTestBackendApplicationTests {

    @Value("${local.server.port}")
    private int port;

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    @Test
    void getShouldEchoQueryParametersAndHeaders() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(uri("/api/test/get?name=Alice&tag=api&tag=test"))
                .header("X-Demo", "get-test")
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(200, response.statusCode());
        assertNotNull(response.headers().firstValue("X-Request-Id").orElse(null));
        assertTrue(response.body().contains("\"method\":\"GET\""));
        assertTrue(response.body().contains("\"name\":[\"Alice\"]"));
        assertTrue(response.body().contains("\"tag\":[\"api\",\"test\"]"));
        assertTrue(response.body().contains("\"X-Demo\":[\"get-test\"]"));
    }

    @Test
    void postShouldEchoJsonBody() throws Exception {
        String json = "{\"name\":\"Alice\",\"age\":18,\"tags\":[\"api\",\"test\"]}";
        HttpRequest request = HttpRequest.newBuilder(uri("/api/test/post?source=test"))
                .header("Content-Type", "application/json; charset=UTF-8")
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("\"method\":\"POST\""));
        assertTrue(response.body().contains("\"body\":"));
        assertTrue(response.body().contains("Alice"));
        assertTrue(response.body().contains("\"bodyTruncated\":false"));
        assertTrue(response.body().contains("\"contentType\":\"application/json; charset=UTF-8\""));
    }

    @Test
    void postShouldEchoMultipartFormDataAndFile() throws Exception {
        String boundary = "----ApiToolTestBoundary" + System.nanoTime();
        String multipartBody = "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"name\"\r\n\r\n"
                + "Alice\r\n"
                + "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"hello.txt\"\r\n"
                + "Content-Type: text/plain\r\n\r\n"
                + "hello\r\n"
                + "--" + boundary + "--\r\n";

        HttpRequest request = HttpRequest.newBuilder(uri("/api/test/post"))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .timeout(Duration.ofSeconds(10))
                .POST(HttpRequest.BodyPublishers.ofString(multipartBody, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("\"formFields\":{\"name\":"));
        assertTrue(response.body().contains("Alice"));
        assertTrue(response.body().contains("\"originalFilename\":\"hello.txt\""));
        assertTrue(response.body().contains("\"size\":5"));
        assertTrue(response.body().contains("\"body\":null"));
    }

    @Test
    void putShouldEchoPathVariableAndJsonBody() throws Exception {
        String json = "{\"name\":\"updated\"}";
        HttpRequest request = HttpRequest.newBuilder(uri("/api/test/put/42?source=test"))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(10))
                .PUT(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("\"method\":\"PUT\""));
        assertTrue(response.body().contains("\"pathVariables\":{\"id\":\"42\"}"));
        assertTrue(response.body().contains("updated"));
    }

    @Test
    void deleteShouldEchoQueryParameters() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(uri("/api/test/delete/42?reason=cleanup"))
                .timeout(Duration.ofSeconds(10))
                .DELETE()
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("\"method\":\"DELETE\""));
        assertTrue(response.body().contains("\"reason\":[\"cleanup\"]"));
        assertTrue(response.body().contains("\"pathVariables\":{\"id\":\"42\"}"));
    }

    @Test
    void genericEchoShouldSupportPatch() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(uri("/api/echo/anything"))
                .header("Content-Type", "text/plain; charset=UTF-8")
                .timeout(Duration.ofSeconds(10))
                .method("PATCH", HttpRequest.BodyPublishers.ofString("hello echo", StandardCharsets.UTF_8))
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(200, response.statusCode());
        assertTrue(response.body().contains("\"method\":\"PATCH\""));
        assertTrue(response.body().contains("hello echo"));
    }

    @Test
    void statusEndpointShouldReturnRequestedStatus() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(uri("/api/test/status/418"))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(418, response.statusCode());
        assertTrue(response.body().contains("\"actualStatus\":418"));
        assertTrue(response.body().contains("\"success\":false"));
    }

    @Test
    void exportTextShouldReturnAttachmentWithChineseFilename() throws Exception {
        String filename = "导出测试.txt";
        String encodedFilename = URLEncoder.encode(filename, StandardCharsets.UTF_8);
        HttpRequest request = HttpRequest.newBuilder(
                        uri("/api/test/export?format=text&filename=" + encodedFilename))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        String disposition = response.headers().firstValue("Content-Disposition").orElse("");

        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("Content-Type").orElse("").startsWith("text/plain"));
        assertTrue(disposition.startsWith("attachment;"));
        assertTrue(disposition.contains("filename*=UTF-8''"));
        assertTrue(disposition.contains("%E5%AF%BC%E5%87%BA"));
        assertTrue(new String(response.body(), StandardCharsets.UTF_8).contains("API 文件导出测试"));
        assertEquals(String.valueOf(response.body().length),
                response.headers().firstValue("X-Export-Size").orElse(""));
        assertNotNull(response.headers().firstValue("X-Request-Id").orElse(null));
    }

    @Test
    void exportJsonShouldReturnJsonFile() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(
                        uri("/api/test/export?format=json&filename=report.json"))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        String body = new String(response.body(), StandardCharsets.UTF_8);

        assertEquals(200, response.statusCode());
        assertTrue(response.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
        assertTrue(body.contains("\"format\": \"json\""));
        assertTrue(body.contains("API 文件导出测试成功"));
        assertTrue(response.headers().firstValue("Content-Disposition").orElse("").contains("report.json"));
    }

    @Test
    void exportCsvShouldIncludeUtf8BomAndChineseContent() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(
                        uri("/api/test/export?format=csv&filename=report.csv"))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
        byte[] body = response.body();
        String content = new String(body, StandardCharsets.UTF_8);

        assertEquals(200, response.statusCode());
        assertEquals(0xEF, body[0] & 0xFF);
        assertEquals(0xBB, body[1] & 0xFF);
        assertEquals(0xBF, body[2] & 0xFF);
        assertTrue(content.startsWith("\uFEFFid,name"));
        assertTrue(content.contains("张三"));
        assertTrue(content.contains("测试工程师"));
    }

    @Test
    void exportBinaryShouldReturnRequestedSize() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(
                        uri("/api/test/export?format=binary&size=2048&filename=blob.bin"))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());

        assertEquals(200, response.statusCode());
        assertEquals(2048, response.body().length);
        assertEquals((byte) 17, response.body()[0]);
        assertTrue(response.headers().firstValue("Content-Type").orElse("")
                .startsWith("application/octet-stream"));
        assertEquals("2048", response.headers().firstValue("X-Export-Size").orElse(""));
        assertTrue(response.headers().firstValue("Content-Disposition").orElse("")
                .contains("blob.bin"));
    }

    @Test
    void exportInvalidFormatShouldReturnBadRequest() throws Exception {
        HttpRequest request = HttpRequest.newBuilder(uri("/api/test/export?format=xml"))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<String> response = send(request);

        assertEquals(400, response.statusCode());
        assertTrue(response.body().contains("\"success\":false"));
        assertTrue(response.body().contains("不支持的导出格式"));
    }

    private URI uri(String pathAndQuery) {
        return URI.create("http://127.0.0.1:" + port + pathAndQuery);
    }

    private HttpResponse<String> send(HttpRequest request) throws Exception {
        return httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }
}
