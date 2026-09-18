# Ubuntu 26.04 WSL Tesla 測試

呢部電腦已裝好 Sunshine、獨立 XFCE 桌面、音訊輸出同網頁串流服務，亦已自動配對。
Browser 經正式 HTTPS 網址及 Cloudflare TURN 實測有約 30 fps 畫面、鍵盤／滑鼠輸入
同音訊解碼；測試連線往返延遲約 40 ms。Tesla 實機尚未測試。

## 喺呢部 Windows 電腦試

開 <http://localhost:43780>，登入後揀 **Ubuntu 26.04 WSL Desktop**，再開
**Ubuntu WSL Desktop**。呢個係獨立 Ubuntu 桌面。

登入密碼喺 WSL 私人設定檔：

```text
/home/omega/.config/tesla-moonlight-ubuntu/internet.json
```

用 Windows PowerShell 喺自己螢幕讀取 `web_password`：

```powershell
wsl -d Ubuntu-26.04 -- jq -r .web_password /home/omega/.config/tesla-moonlight-ubuntu/internet.json
```

## 喺 Tesla 測試

公開網址係 <https://ubuntu-sunshine.isese.com>。Tunnel 已連線，現有 Cloudflare
origin `localhost:8080` 會經本機轉接去網頁服務 `43780`，HTTPS 已回傳 HTTP 200。
TURN 已設定並驗證，browser 同 server 都使用 Cloudflare relay 傳送媒體。

1. 保持 Windows 電腦開機、連網，Ubuntu WSL 保持運行。
2. 泊好車，喺 Tesla browser 開 <https://ubuntu-sunshine.isese.com>。
3. 用上面 `web_password` 登入；未設定 2FA 嘅話留空 2FA 欄。
4. 揀 **Ubuntu 26.04 WSL Desktop** → **YouTube Remote** 或 **Ubuntu WSL Desktop**。
5. 如果見到舊 session，揀 **Resume Session**。先試 **Reliable** 畫質。
6. 左邊箭嘴展開控制列，**Keyboard** 開軟件鍵盤；點一下畫面可啟動音訊。

Tesla 唔需要同電腦用同一個 Wi-Fi；呢個網址使用 HTTPS Tunnel 同 TURN relay。
Tesla 開 `localhost` 會指向架車本身，唔係呢部電腦。

## YouTube 同 Sunshine 選單

**YouTube Remote** 會喺獨立 Ubuntu Chrome profile 開 YouTube。左邊箭嘴展開
原版 Tesla Touch 選單，可搜尋、方向鍵選片、播放／暫停、快進／倒後 10 秒、
調音量、靜音、字幕同播放器全螢幕。右上角 × 關閉專用 Chrome，露出 Ubuntu 桌面。
之後想重新開 YouTube，可返回應用程式清單，揀 **Stop Current Session**，再開
**YouTube Remote**；**Resume Session** 會繼續原本嘅桌面 session。

展開 **Stream & input settings**：

| 設定 | 功能 |
|---|---|
| Window | 1600×1200 |
| Full | 1920×1080 |
| Auto | 跟目前 browser 比例，最高 1920×1080 |
| Reliable / High / Ultra | 三個串流畫質預設 |
| Height / Width / Fill | 畫面縮放方式 |
| Menu opacity / Zoom / Shadow Boost / Stats | 選單透明度、縮放、暗位及統計 |

切換解像度會短暫重新連線，WSL 桌面會同步轉換實際尺寸。
Ubuntu Applications 選單另有 **Sunshine Settings**，開本機管理介面。
YouTube 登入可由你喺專用 Chrome 完成；profile 會保留。

重新安裝 YouTube 功能：

```bash
bash install.sh --install-youtube-deps
bash install.sh --youtube
```

## 日後更改設定

私人 `internet.json` 已包含登入密碼、Tunnel token 同 TURN 設定。日後更改後重新套用：

```bash
nano ~/.config/tesla-moonlight-ubuntu/internet.json
cd /mnt/d/AI/codex/sunshine-ubuntu
bash install.sh --wsl --config ~/.config/tesla-moonlight-ubuntu/internet.json
```

填 `public_hostname` 時只寫 hostname，唔加 `https://`。
如果由呢個程式啟動 tunnel，亦要填 `cloudflare_tunnel_token`；已由其他服務管理嘅
tunnel 可以留空。Tunnel token 同 TURN API token 係兩樣嘢。

設定完成後，泊好車先喺 Tesla 開 `https://你嘅hostname`，登入並開 Ubuntu WSL Desktop。
先用 **Reliable** 畫質。唔好公開 Sunshine 管理介面（47990）。

## 重新安裝或檢查

```bash
cd /mnt/d/AI/codex/sunshine-ubuntu
bash install.sh --check
journalctl --user -u tesla-wsl-sunshine -n 60
```

新 WSL 安裝：先 `bash install.sh --install-wsl-deps`，再 `bash install.sh --wsl`。
發佈壓縮檔已有 Ubuntu 26.04 amd64 runtime，無需重新編譯。
Windows 休眠／關閉 WSL 會中斷串流；遊戲手掣及 Tesla 真車音訊／觸控仍需測試。
