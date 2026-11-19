# FIFA 2003 native window streaming

One Windows PC runs FIFA 2003 and streams its window to browser viewers over WebRTC. The host plays with the native game controls. The two lobby seats are viewing seats. The prototype streams video only.

## Prepare the host

Install Python 3.11 or newer, Node.js 24 or newer with npm, and desktop Edge or Chrome. For LAN access, also install Caddy 2.

In `host.cfg`, set `game_dir` to your installed English PC Build 325 folder. It must contain `fifa2003.exe`, `soccer.ini`, the game data directory, and the x86 dgVoodoo files `D3D8.dll`, `DDraw.dll`, and `dgVoodoo.conf`. Use the D3D11 profile with `FullScreenMode = false`.

Leave `lan_ip` blank for local viewing. For LAN viewing, enter the Windows host’s adapter IPv4 address and set `caddy_path` if Caddy is outside PATH. From the repository directory, run the following commands.

```powershell
python prepare.py
python host.py
```

Preparation verifies the game build and installs the locked signaling dependency. Run the host in the interactive Windows desktop session.

## Start and watch a match

1. On the host, open the printed private **Windows runner** URL, including its key. Click **Enable runner** to launch FIFA, then **Share FIFA window** and select the game from the browser’s window picker.
2. Open the **Local player address** in another browser window, or give a LAN viewer the printed HTTPS player address. For LAN HTTPS, transfer the public Caddy root certificate from the printed path and trust it on the viewer’s device.
3. Claim an available seat to watch. The viewer shows decoded FPS, dropped frames, and round-trip time. Use **Leave** to free the seat. A disconnected tab can reclaim its seat within `reconnect_seconds`.
4. If FIFA changes windows, select **Share FIFA window** again. The lobby holds the seats during reselection. Use **End session** to close FIFA and release the seats, or Ctrl+C in the terminal to shut down the host.

## Verification

Run `node --test shared/room.test.mjs` to check runner authorization, session lifecycle, capture recovery, and seat reconnection.

Window capture requests up to 1280×720 at 30 FPS. One local Edge viewer decoded 29–30 FPS during match loading. The tested FIFA process exited with Windows access violation `0xc0000005` before kickoff, so sustained live-match FPS remains unverified.
