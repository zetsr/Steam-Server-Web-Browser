# Steam-Server-Web-Browser

<img width="1894" height="900" alt="image" src="https://github.com/user-attachments/assets/48d3b649-8ef5-4283-b200-83e37ed208a8" />

## 使用方法
#### 从 [releases](https://github.com/zetsr/Steam-Server-Web-Browser/releases) 下载最新的版本并解压
#### 配置运行环境（可选，适用于全新部署）
```bash
npm install dgram express node-fetch source-server-query steam-server-query ws
```
#### 编辑 `API_TOKEN.json`（填入你的 [ipinfo.io](https://ipinfo.io) Token）
```json
{
    "IPINFO_TOKEN": "YOUR_KEY"
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

#### 启动服务
```bash
node server.js --port=3000 --concurrency=8 --INFO_TIMEOUT=2500 --UpdateServerIPsTime=300s --UpdateServerInfoTime=15s
```

---

#### 启动项（可选参数，大小写不敏感）

本程序支持通过命令行参数调整运行配置。  
格式可用 `--参数名=值` 或 `--参数名 值`，参数名大小写不敏感，`-` 和 `_` 都可用。  
未传入或传入非法值时，会自动回退到默认值并打印警告。

| 参数名 | 说明 | 默认值 | 支持的单位与格式 | 备注 |
|--------|------|--------|------------------|------|
| `--port` | HTTP/WebSocket 服务端口 | `80` | 正整数 | 小于 65536 |
| `--CONCURRENCY` | 并发查询上限 | `10` | 正整数 | 建议根据机器性能调整 |
| `--INFO_TIMEOUT` | 查询服务器信息超时 | `2000ms` | 裸数字=毫秒<br>`3000ms`=毫秒<br>`3s`=秒 | 仅影响单次 Query.info / Query.players |
| `--UpdateServerIPsTime` | 更新服务器 IP 列表间隔 | `600s` | 裸数字=秒<br>`600000ms`=毫秒<br>`600s`=秒 | 过小会频繁请求 Steam Master Server |
| `--UpdateServerInfoTime` | 更新服务器信息间隔 | `30s` | 裸数字=秒<br>`30000ms`=毫秒<br>`30s`=秒 | 过小会频繁请求各游戏服务器 |

---
