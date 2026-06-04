import asyncio
import json
import subprocess
import time
import urllib.request
import websockets
import sys
import shutil
import os
from pathlib import Path

async def send_cdp(ws, method, params=None):
    req = {
        "id": 1,
        "method": method,
        "params": params or {}
    }
    await ws.send(json.dumps(req))
    resp = await ws.recv()
    return json.loads(resp)

async def get_cookies_from_profile(profile_path, port=9333):
    # To bypass Chrome's default-profile remote debugging lockdown,
    # copy only the Cookies database to a temporary user-data-dir
    temp_dir = Path("/tmp/chrome-local-sync-temp")
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    
    # We need to recreate the directory structure: <temp_dir>/Default/Cookies
    default_dir = temp_dir / "Default"
    default_dir.mkdir(parents=True, exist_ok=True)
    
    source_cookies = Path(profile_path) / "Default" / "Cookies"
    if not source_cookies.exists():
        # Maybe the profile_path is already the Default folder or has a different structure
        source_cookies = Path(profile_path) / "Cookies"
        if not source_cookies.exists():
            print(f"Error: Could not find Cookies file in {profile_path}")
            return []

    print(f"Copying {source_cookies} to temporary profile...")
    shutil.copy(source_cookies, default_dir / "Cookies")

    print(f"Launching source browser in headless mode on port {port}...")
    proc = subprocess.Popen([
        "/usr/bin/google-chrome-stable",
        "--headless=new",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={temp_dir}",
        "--disable-gpu",
        "--no-first-run"
    ])
    
    # Wait for the browser to start
    time.sleep(2)
    
    try:
        # Get the browser webSocketDebuggerUrl
        resp = urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version").read()
        info = json.loads(resp.decode())
        ws_url = info["webSocketDebuggerUrl"]
        print(f"Connected to source browser: {ws_url}")
        
        async with websockets.connect(ws_url) as ws:
            # Enable Network domain
            await send_cdp(ws, "Network.enable")
            # Get all cookies
            res = await send_cdp(ws, "Storage.getCookies")
            cookies = res.get("result", {}).get("cookies", [])
            print(f"Successfully retrieved {len(cookies)} cookies from source profile.")
            return cookies
    except Exception as e:
        print(f"Failed to extract cookies: {e}")
        return []
    finally:
        print("Terminating source browser...")
        proc.terminate()
        proc.wait()
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass

async def inject_cookies_to_target(cookies, target_url_env="http://[::1]:9222"):
    from urllib.parse import urlparse
    parsed = urlparse(target_url_env)
    host = parsed.hostname or "[::1]"
    port = parsed.port or 9222
    
    # If hostname is an IPv6 address (contains colons) and doesn't have brackets, add them
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
        
    print(f"Connecting to target browser on {host}:{port} (from {target_url_env})...")
    try:
        resp = urllib.request.urlopen(f"http://{host}:{port}/json").read()
        info = json.loads(resp.decode())
        page_targets = [t for t in info if t.get("type") == "page"]
        if not page_targets:
            print("No page targets found on target browser.")
            return False
        ws_url = page_targets[0]["webSocketDebuggerUrl"]
        print(f"Connected to target page: {ws_url}")
    except Exception as e:
        print(f"Error connecting to target browser on {host}:{port}: {e}")
        return False
        
    async with websockets.connect(ws_url) as ws:
        print("Injecting cookies...")
        # Enable Network first on target
        await send_cdp(ws, "Network.enable")
        
        success_count = 0
        for c in cookies:
            param = {
                "name": c["name"],
                "value": c["value"],
                "domain": c["domain"],
                "path": c["path"],
                "secure": c.get("secure", False),
                "httpOnly": c.get("httpOnly", False),
            }
            if "sameSite" in c:
                param["sameSite"] = c["sameSite"]
            if "expires" in c:
                param["expires"] = c["expires"]
            
            res = await send_cdp(ws, "Network.setCookie", param)
            if res.get("result", {}).get("success", False):
                success_count += 1
            else:
                # Some cookies might fail or print error if debug is needed
                pass
                
        print(f"Successfully injected {success_count}/{len(cookies)} cookies into target browser.")
        return True

async def main():
    source_profile = "/home/louis/.config/google-chrome"
    if len(sys.argv) > 1:
        source_profile = sys.argv[1]
        
    cookies = await get_cookies_from_profile(source_profile)
    if cookies:
        target_url = os.environ.get("BU_CDP_URL", "http://[::1]:9222")
        await inject_cookies_to_target(cookies, target_url)

if __name__ == "__main__":
    asyncio.run(main())
