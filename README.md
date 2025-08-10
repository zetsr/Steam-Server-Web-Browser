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
node server.js
```
