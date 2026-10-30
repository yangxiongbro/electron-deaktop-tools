package org.example.apitooltestbackend.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 允许 Electron 工具、浏览器调试页等跨域调用测试接口。
 * 仅用于本地测试，生产环境请收紧 allowedOriginPatterns。
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/**")
                .allowedOriginPatterns("*")
                .allowedMethods("GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS")
                .allowedHeaders("*")
                .exposedHeaders(
                        "X-Request-Id",
                        "X-Server-Name",
                        "Content-Disposition",
                        "X-Export-Format",
                        "X-Export-Size"
                )
                .allowCredentials(false)
                .maxAge(3600);
    }
}
