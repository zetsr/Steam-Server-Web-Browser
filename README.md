# Steam-Server-Web-Browser

## 使用方法

- 编辑 `API_TOKEN.json`（填入你的 [ipinfo.io](https://ipinfo.io) Token）
```json
{
    "IPINFO_TOKEN": "YOUR_KEY"
}
```

- 编辑 app_id.json（填入要查询的 Steam 游戏 App ID）

```json
[
    1088090,
    2520410,
    1295900
]  
```

- 启动服务

```bash
node server.js
```
