# Steam-Server-Web-Browser

<img width="1894" height="900" alt="image" src="https://github.com/user-attachments/assets/48d3b649-8ef5-4283-b200-83e37ed208a8" />

## 使用方法
#### 从 [releases](https://github.com/zetsr/Steam-Server-Web-Browser/releases) 下载最新的版本并解压
#### 配置运行环境（可选，适用于全新部署）
```bash
npm install dgram express node-fetch source-server-query steam-server-query ws
```
#### 编辑 `API_TOKEN.json`（填入你的 [ipinfo.io](https://ipinfo.io) Token 和 [Steam Dev API](https://steamcommunity.com/dev/apikey) Token）
```json
{
    "IPINFO_TOKEN": "YOUR_KEY"
    "STEAM_API_KEY": "YOUR_KEY"
}
```
#### 编辑 app_id.json（填入要查询的 Steam 游戏 App ID）
```json
[
    1088090,
    2520410,
    1295900
]  
```
#### 配置并生成.pfx证书
示例
```base
"C:\Users\Administrator\Desktop\win-acme.v2.2.9.1701.x64.pluggable\wacs.exe" --target manual --host yourdomain.com --store pemfiles --pemfilespath C:\certs --installation none
```
```bash
"C:\Program Files\OpenSSL-Win64\bin\openssl.exe" pkcs12 -export -out yourdomain.com.pfx -inkey yourdomain.com-key.pem -in yourdomain.com-crt.pem -certfile yourdomain.com-chain.pem -passout pass:YourStrongPassword123
```
#### 启动服务
```bash
node server.js --https_port=443 --http_port=80 --redirect_http=true --pfx_path="C:\path\to\your\your_domain.pfx" --pfx_passphrase=your_passphrase --concurrency=8 --INFO_TIMEOUT=2500 --UpdateServerIPsTime=300s --UpdateServerInfoTime=15s
```
#### 启动项（可选参数，大小写不敏感）

本程序支持通过命令行参数调整运行配置。  
格式可用 `--参数名=值` 或 `--参数名 值`，参数名大小写不敏感，`-` 和 `_` 都可用。  
未传入或传入非法值时，会自动回退到默认值并打印警告。

| 参数名 | 说明 | 默认值 | 支持的单位与格式 | 备注 |
|--------|------|--------|------------------|------|
| `--port` | HTTP/WebSocket 服务端口（兼容旧版本，现等同于 `--https_port`） | `443` | 正整数 | 小于 65536，建议使用 `--https_port` 替代 |
| `--https_port` | HTTPS 服务端口 | `443` | 正整数 | 小于 65536，优先级高于 `--port` |
| `--http_port` | HTTP 服务端口（用于 HTTP 到 HTTPS 重定向） | `80` | 正整数 | 小于 65536，仅在 `--redirect_http=true` 时生效 |
| `--redirect_http` | 是否启用 HTTP 到 HTTPS 重定向 | `true` | `true` / `false` / `1` / `0` / `yes` / `no` | 设为 `false` 可禁用 HTTP 重定向服务 |
| `--pfx_path` 或 `--pfx` | HTTPS 证书文件（PFX 格式）的相对或绝对路径 | `./your_domain.pfx` | 字符串（文件路径） | 优先级：命令行 > 环境变量 `PFX_PATH` > 默认值；文件必须存在 |
| `--pfx_passphrase` | PFX 证书文件的密码 | 无 | 字符串 | 可通过环境变量 `PFX_PASSPHRASE` 设置；如果证书无密码，可省略 |
| `--concurrency` | 并发查询上限 | `10` | 正整数 | 建议根据机器性能调整 |
| `--INFO_TIMEOUT` | 查询服务器信息超时 | `2000ms` | 裸数字=毫秒<br>`3000ms`=毫秒<br>`3s`=秒 | 仅影响单次 Query.info / Query.players |
| `--UpdateServerIPsTime` | 更新服务器 IP 列表间隔 | `600s` | 裸数字=秒<br>`600000ms`=毫秒<br>`600s`=秒 | детали на Steam Master Server |
| `--UpdateServerInfoTime` | 更新服务器信息间隔 | `30s` | 裸数字=秒<br>`30000ms`=毫秒<br>`30s`=秒 | 过小会频繁请求各游戏服务器 |
