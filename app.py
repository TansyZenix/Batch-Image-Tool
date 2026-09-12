"""批量图片处理工具 —— Flask 后端。

启动：
    pip install -r requirements.txt
    python app.py

然后浏览器打开 http://127.0.0.1:5000
"""

from __future__ import annotations

import io
import shutil
import time
import uuid
import zipfile
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file

from processor import FORMATS, SUPPORTED_SUFFIXES, list_images, load_upright, process_batch

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_ROOT = BASE_DIR / "uploads"
OUTPUT_ROOT = BASE_DIR / "outputs"

app = Flask(__name__)
app.json.ensure_ascii = False  # 中文文件名在 JSON 中保持原样
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 单次上传上限 2 GB


# --------------------------------------------------------------------------
# 辅助函数
# --------------------------------------------------------------------------

def session_dir(root, session):
    """定位会话目录，并挡住非法的会话 ID（防目录穿越）。"""
    if not session or not session.isalnum():
        abort(400, description="会话 ID 无效")
    path = root / session
    if not path.is_dir():
        abort(404, description="会话不存在，请重新选择图片")
    return path


def safe_file(folder, name):
    """在会话目录内定位文件，拒绝任何越界路径。"""
    target = (folder / name).resolve()
    if not target.is_relative_to(folder.resolve()) or not target.is_file():
        abort(404, description="文件不存在")
    return target


def unique_name(folder, name):
    """避免同批上传时重名互相覆盖。"""
    candidate = name
    stem, suffix = Path(name).stem, Path(name).suffix
    n = 2
    while (folder / candidate).exists():
        candidate = f"{stem}_{n}{suffix}"
        n += 1
    return candidate


# --------------------------------------------------------------------------
# 页面与接口
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/upload")
def upload():
    """接收一批图片，存入独立会话目录，返回文件名与原始尺寸。"""
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "没有收到任何文件"}), 400

    session = uuid.uuid4().hex
    folder = UPLOAD_ROOT / session
    folder.mkdir(parents=True, exist_ok=True)

    images, skipped = [], []
    for item in files:
        if not item.filename:
            continue
        if Path(item.filename).suffix.lower() not in SUPPORTED_SUFFIXES:
            skipped.append(item.filename)
            continue

        name = unique_name(folder, Path(item.filename).name)
        item.save(folder / name)
        try:
            width, height = load_upright(folder / name).size
        except Exception:  # noqa: BLE001 - 损坏的图片直接跳过
            (folder / name).unlink(missing_ok=True)
            skipped.append(item.filename)
            continue

        images.append({
            "name": name,
            "url": f"/api/image/{session}/{name}",
            "width": width,
            "height": height,
        })

    if not images:
        shutil.rmtree(folder, ignore_errors=True)
        return jsonify({"error": "没有可用的图片，请检查文件格式"}), 400

    return jsonify({"session": session, "images": images, "skipped": skipped})


@app.get("/api/image/<session>/<path:name>")
def image(session, name):
    """提供原图给前端显示。"""
    folder = session_dir(UPLOAD_ROOT, session)
    return send_file(safe_file(folder, name), max_age=0)


@app.post("/api/export")
def export():
    """按每张图片各自的参数批量处理，返回处理报告与下载地址。"""
    payload = request.get_json(silent=True) or {}
    folder = session_dir(UPLOAD_ROOT, payload.get("session"))

    ops_by_name = payload.get("ops") or {}
    output = payload.get("output") or {}

    fmt = (output.get("format") or "jpg").lower()
    if fmt not in FORMATS:
        fmt = "jpg"
    try:
        quality = max(1, min(100, int(output.get("quality") or 92)))
    except (TypeError, ValueError):
        quality = 92
    output = {**output, "format": fmt, "quality": quality}

    dest = OUTPUT_ROOT / folder.name
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)

    started = time.time()
    results = process_batch(folder, dest, ops_by_name, output)
    elapsed = time.time() - started

    ok = [r for r in results if r["status"] == "ok"]
    failed = [r for r in results if r["status"] != "ok"]

    (dest / "report.txt").write_text(build_report(results, output, elapsed), encoding="utf-8-sig")

    return jsonify({
        "total": len(results),
        "ok": len(ok),
        "failed": len(failed),
        "results": results,
        "elapsed": round(elapsed, 2),
        "download": f"/api/download/{folder.name}" if ok else None,
    })


@app.get("/api/download/<session>")
def download(session):
    """把处理结果打包成 zip 下载。"""
    folder = session_dir(OUTPUT_ROOT, session)
    produced = list_images(folder)
    if not produced:
        abort(404, description="还没有可下载的处理结果")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in produced:
            archive.write(path, path.name)
        report = folder / "report.txt"
        if report.exists():
            archive.write(report, report.name)
    buffer.seek(0)

    stamp = time.strftime("%Y%m%d_%H%M%S")
    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"batch_output_{stamp}.zip",
    )


@app.post("/api/reset/<session>")
def reset(session):
    """清空一个会话的上传与输出。"""
    if not session or not session.isalnum():
        abort(400, description="会话 ID 无效")
    for root in (UPLOAD_ROOT, OUTPUT_ROOT):
        shutil.rmtree(root / session, ignore_errors=True)
    return jsonify({"ok": True})


def build_report(results, output, elapsed):
    """生成随 zip 一起下载的处理报告。"""
    resize_mode = (output.get("resize") or {}).get("mode", "original")
    lines = [
        "批量图片处理报告",
        "=" * 40,
        f"处理总数：{len(results)}",
        f"成功：{sum(1 for r in results if r['status'] == 'ok')}",
        f"失败：{sum(1 for r in results if r['status'] != 'ok')}",
        f"耗时：{elapsed:.2f} 秒",
        f"导出格式：{output.get('format', 'jpg').upper()}"
        + (f"（质量 {output.get('quality')}）" if output.get("format") != "png" else ""),
        f"缩放模式：{resize_mode}",
        "",
        "逐张明细",
        "-" * 40,
    ]
    for item in results:
        if item["status"] == "ok":
            lines.append(f"[成功] {item['name']}  ->  {item['output']}  ({item['size']})")
        else:
            lines.append(f"[失败] {item['name']}  ->  {item['error']}")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    print("批量图片处理工具已启动：http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False)
