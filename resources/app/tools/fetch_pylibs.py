"""
从国内镜像抓 wheel 并直接解压，绕开 pip。

为什么不用 pip：
  本机 `pip install --target` 会卡死（扫描上万个文件的 target 目录，实测 20 分钟无输出），
  `pip download` 会在依赖解析阶段卡死（547 CPU 秒无输出）。
  见 web-research skill §4.3。所以走 PyPI JSON API 拿 URL → 直接 HTTP 下载 → zipfile 解压。

为什么要 fpdf2：
  Chromium 在 DSH 沙箱里跑不起来（Mojo 命名管道被拦），所以无法用浏览器打印 PDF。
  fpdf2 是纯 Python，能在沙箱内直接产出 PDF，且自带 write_html()，
  可以直接吃我们生成的 HTML，省掉自己写排版引擎。

用法：<python> fetch_pylibs.py fpdf2 fonttools defusedxml
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.request
import zipfile

try:
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

UA = {"User-Agent": "Mozilla/5.0"}
# PyPI 镜像的 URL 重写表。
#
# ⚠️ 关键：不能只换 host！各镜像把 packages 挂在不同的路径前缀下，
# 只换 host 会拿到一个 HTTP 200 的 HTML 错误页（约 12 KB，不是 zip），
# 然后解压时报 "File is not a zip file" —— 很容易误判成网络问题。
# 实测：
#   原站                                   -> PK ✓
#   mirrors.huaweicloud.com（只换 host）    -> HTML 错误页 ✗
#   mirrors.huaweicloud.com/repository/pypi -> PK ✓
#   mirrors.aliyun.com/pypi                 -> PK ✓
#   pypi.tuna.tsinghua.edu.cn（只换 host）  -> 403 ✗
ORIGIN = "https://files.pythonhosted.org"
MIRROR_BASES = [
    "https://mirrors.huaweicloud.com/repository/pypi",
    "https://mirrors.aliyun.com/pypi",
    "https://mirrors.cloud.tencent.com/pypi",
]
DEST = os.path.join(
    r"C:\Users\李英睿\Documents\deepseek-harness\default-workspace",
    "Workspace_Config", ".cache", "pylibs",
)


def pypi_json(pkg: str) -> dict:
    url = "https://pypi.org/pypi/%s/json" % pkg
    return json.loads(urllib.request.urlopen(
        urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "ignore"))


def pick_wheel(info: dict) -> tuple[str, str] | None:
    """挑一个 py3-none-any 或 cp3xx win_amd64 的 wheel。"""
    ver = info["info"]["version"]
    files = info["releases"].get(ver, [])
    wheels = [f for f in files if f["filename"].endswith(".whl")]
    if not wheels:
        return None
    # 优先纯 Python
    pure = [f for f in wheels if "py3-none-any" in f["filename"] or "py2.py3-none-any" in f["filename"]]
    win = [f for f in wheels if "win_amd64" in f["filename"]]
    chosen = (pure or win or wheels)[0]
    return chosen["url"], chosen["filename"]


def mirror_urls(url: str) -> list[str]:
    """原站 URL → 候选下载 URL 列表（镜像优先，原站兜底）。

    注意要把 ORIGIN 整段换掉（含它后面的 /packages 之前什么都不动），
    镜像 base 里已经自带路径前缀。
    """
    out = []
    for base in MIRROR_BASES:
        if url.startswith(ORIGIN):
            out.append(base + url[len(ORIGIN):])
    out.append(url)  # 原站兜底
    return out


def get(url: str, timeout: int = 120) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def main() -> None:
    pkgs = sys.argv[1:] or ["fpdf2"]
    os.makedirs(DEST, exist_ok=True)
    print("  目标目录: %s" % DEST)
    installed = []
    for pkg in pkgs:
        try:
            info = pypi_json(pkg)
        except Exception as e:
            print("  [失败] %-14s 查 PyPI 失败: %s" % (pkg, e))
            continue
        pick = pick_wheel(info)
        if not pick:
            print("  [失败] %-14s 没有 wheel" % pkg)
            continue
        url, fname = pick
        data = None
        for u in mirror_urls(url):
            try:
                t0 = time.time()
                data = get(u)
                if not data[:2] == b"PK":
                    # 关键校验：镜像有时返回 HTTP 200 的 HTML 错误页，
                    # 不校验就会一路走到解压才报 "File is not a zip file"。
                    print("      %s -> 不是 zip（%d B，前 20 字节 %r）"
                          % (u[:56], len(data), data[:20]))
                    data = None
                    continue
                print("  [下载] %-14s %-40s %6.1f KB  %.1fs"
                      % (pkg, fname[:40], len(data) / 1024, time.time() - t0))
                break
            except Exception as e:
                print("      %s 失败: %s" % (u[:56], e))
        if data is None:
            continue
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                z.extractall(DEST)
            installed.append(pkg)
        except Exception as e:
            print("  [失败] %-14s 解压出错: %s" % (pkg, e))

    print("\n  已解压: %s" % ", ".join(installed))
    print("  目录内容前 20 项:")
    for n in sorted(os.listdir(DEST))[:20]:
        print("    %s" % n)


if __name__ == "__main__":
    main()
