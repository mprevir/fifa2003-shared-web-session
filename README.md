# FIFA 2003 shared web session

The host needs their own copy of FIFA 2003 for Windows. Use your installed copy or download a copy you are authorized to use from the [Internet Archive](https://archive.org/search?query=FIFA+2003). This setup supports the English PC Build 325 executable. Install or extract the game before continuing. Use a complete installation for the original music and commentary. Preparation packages the assets present in your copy.

One Windows PC runs FIFA in a dedicated browser window called the **runner**. Two players join the same match from desktop browsers, either on that PC or on the same LAN. Only the runner PC needs the game. Either player can take Player 1 and operate the menus.

## Prepare the Windows host once

1. Clone or extract this repository. Install Python 3.11 or newer, Node.js 24 or newer with npm, and desktop Chrome or Edge. For LAN play, also install Caddy 2. [Python for Windows](https://www.python.org/downloads/windows/) · [Node.js downloads](https://nodejs.org/en/download) · [Caddy installation](https://caddyserver.com/docs/install)
2. Open `host.cfg` in the repository root. Set `game_dir` to the folder containing `fifa2003.exe`, `soccer.ini`, and `data`, for example `D:\Games\FIFA 2003`. Paths can include spaces. Enter them without quotation marks. Relative paths resolve from the configuration file.
3. For same-PC play, leave `lan_ip` blank. For LAN play, run `ipconfig` and enter the Windows host's active Wi-Fi or Ethernet IPv4 address. Set `caddy_path` to the full path to `caddy.exe` if it is outside your PATH.
4. Open PowerShell in the repository root and run the following command.

```powershell
python prepare.py
```

Preparation installs the locked Node signaling library, downloads and verifies the pinned Boxedwine runtime and Wine filesystem, and packages your game into `stage\fifa325-pad.zip`. Allow several minutes and at least 2 GB of free disk space on top of the installed game. The script sets the game’s video and audio options in the packaged copy. The 32-bit Xidi 5.0 controller libraries, license notices, and XInput bridge ship in `controller\`. Python uses only its standard library.

Rerun preparation after changing the installation, runner or player code, or runtime files. Starting another match or changing network settings only requires restarting the host.

## Host a session

```powershell
python host.py
```

1. Open the printed **Windows runner** URL in a dedicated Chrome or Edge window on the host. Copy the entire URL, including the private key after `#`. Click **Enable runner and audio** and wait for **Runner online**. Keep that window visible and the PC awake.
2. Give players on the host PC the **Local player invite**. Give players on other devices the **LAN player invite** and the public `root.crt` from the path printed after Caddy starts. Keep the runner URL and certificate private keys on the host.
3. Leave the terminal open. Player 1 can click **End session** to return both players to the lobby for another match. Press **Ctrl+C** in the terminal to stop the server. The room link survives restarts through the identity stored in `shared\.host\`.

All deployment settings live in `host.cfg`. The default local Node port is `18337` and the LAN HTTPS port is `18444`. Both accept values from 1024 through 65535. The default seat reservation is 30 seconds after a disconnect and the game startup timeout is 180 seconds. Both accept 1 through 600 seconds. The Boxedwine URLs can point to a mirror serving the same pinned files.

## Join as a client

1. Open the invite in desktop Chrome or Edge. On another device, connect to the host's LAN first. For two players on one PC, open the second invite in a separate profile or a fresh private window so each player gets a distinct seat.
2. For a LAN invite, your browser must trust the host’s Caddy certificate. Obtain the public `root.crt` directly from the host. On Windows, import it with `certmgr.msc` under **Trusted Root Certification Authorities → Certificates**. On macOS, import it in Keychain Access and trust it for SSL. On Ubuntu, import it as a website authority in the browser’s certificate manager. Reopen the invite.
3. One player clicks **Host** to take Player 1. The other clicks **Wait** before the game starts or **Join as Player 2** when the seat opens. Click **Play with sound** if prompted, then click the game picture to give it keyboard focus.
4. Player 1 presses **Enter** at the title screen and uses the mouse to choose **Play a Club Championship Friendly**. At **Select Sides**, Player 1 presses **Left Arrow** and Player 2 presses **Right Arrow** in their respective windows. Once the keyboard and gamepad icons appear on opposite teams, Player 1 confirms. At kickoff, press **S** to pass.

| Action | Player 1 | Player 2 |
| --- | --- | --- |
| Move | Arrow keys | Arrow keys |
| Pass / shoot | S / D | S / D |
| Long ball / lob | A | A |
| Cross / through ball | W (cross) | W (through ball) |
| Trigger run / sprint | | Q / E |

Refresh the same player tab to reclaim a disconnected seat during its reservation. When Player 2's reservation expires, another guest can join. When Player 1's expires, the room returns to the lobby.

## Troubleshooting

- **Preparation rejects the executable.** Check that `game_dir` points to the installed English Build 325 game. Preparation checks the executable SHA-256 against `dff7f9ae1c6ebe6a73f90013e06ebca8453daa101587a9b7bb7bf51aa2149889`.
- **Runner offline.** Open the private runner link on the Windows host and click **Enable runner and audio**. Leave that window open while playing.
- **LAN invite times out.** Check the host's current IPv4 address and allow inbound TCP on `lan_port` from the local network in Windows Firewall. If the room opens but video or controls fail, check that the devices can communicate directly over WebRTC. Guest Wi-Fi isolation can block that connection.
- **Player 2 sees the match but cannot move.** Click the picture to focus it. If Player 2 joined after kickoff, assign the gamepad at **Select Sides** before the next match.

After preparation, run `node --test shared/room.test.mjs` to check lobby behavior, runner authorization, and seat recovery over loopback.
