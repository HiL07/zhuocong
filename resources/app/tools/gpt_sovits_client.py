"""GPT-SoVITS 客户端（本地 API v2）。

用途：把"合成一句话"这件事封装成一个可测的调用，供 Electron 主进程的 `tts.engine='gpt-sovits'` 使用。

为什么要做**运行时 schema 发现**（而不是写死参数名）：
  GPT-SoVITS 的 api_v2.py 各版本参数名变过（`speed` vs `speed_factor`、
  `text_lang` 必填与否、`media_type`/`streaming_mode` 新增……）。
  它本身是 FastAPI，`GET /openapi.json` 会暴露真实 schema ——
  按 schema 组装 payload 比"按某个版本的记忆硬编码"稳得多，升级也不容易炸。

用户指定的推理参数（2026-10-17）：
  temperature=0.8, top_k=10, top_p=0.9, speed=0.88
  情感前缀：`[平静][慵懒][微微疲惫][自信]` 拼在正文前面

用法：
  # 探活（服务没起时会明确告诉你）
  <python> tools/gpt_sovits_client.py --probe
  # 合成
  <python> tools/gpt_sovits_client.py --ref .local/ref/xx.wav \
      --prompt-text "其实也并不喜欢吃鱼，我的悲伤是水做的" \
      --say "唉……好累。今天外面又下雨了，不想动，就在屏幕里陪着你吧。" \
      --out .local/ref/test.wav
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)

EMOTION_PREFIX = '[平静][慵懒][微微疲惫][自信]'

DEFAULTS = {
    'text_lang': 'zh',
    'prompt_lang': 'zh',
    'top_k': 10,
    'top_p': 0.9,
    'temperature': 0.8,
    'speed_factor': 0.88,
    'media_type': 'wav',
    'text_split_method': 'cut5',
    'batch_size': 1,
    'streaming_mode': False,
}


def _get(url: str, timeout: float = 5.0):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, r.read()


def discover(base: str) -> dict:
    """读 openapi.json，返回 {path, method, params:{name: schema}}。"""
    url = base.rstrip('/') + '/openapi.json'
    status, body = _get(url)
    spec = json.loads(body.decode('utf-8', 'replace'))
    paths = spec.get('paths') or {}
    # 找 TTS 端点：优先 /tts，其次任何包含 tts 的路径
    cand = [p for p in paths if p.strip('/') == 'tts'] or [p for p in paths if 'tts' in p]
    if not cand:
        raise RuntimeError(f'openapi 里找不到 tts 端点：{list(paths)[:10]}')
    path = cand[0]
    ops = paths[path]
    method = 'post' if 'post' in ops else 'get'
    op = ops[method]
    params: dict = {}
    # POST 可能是 requestBody（form/json）也可能是 query 参数
    rb = op.get('requestBody') or {}
    for ct, spec2 in (rb.get('content') or {}).items():
        sch = spec2.get('schema') or {}
        ref = sch.get('$ref')
        if ref:
            name = ref.split('/')[-1]
            sch = (spec.get('components', {}).get('schemas', {}).get(name) or {})
        for k, v in (sch.get('properties') or {}).items():
            params[k] = {'type': v.get('type'), 'required': k in (sch.get('required') or []), 'ct': ct}
    for p in (op.get('parameters') or []):
        params[p.get('name')] = {'type': (p.get('schema') or {}).get('type'),
                                 'required': bool(p.get('required')), 'in': p.get('in')}
    return {'base': base.rstrip('/'), 'path': path, 'method': method, 'params': params, 'raw': op}


def build_payload(schema: dict, args) -> dict:
    """按 schema 组装 payload；参数名有差异时用同义词兜底。"""
    names = schema['params']
    want = dict(DEFAULTS)
    want['text'] = args.say
    want['ref_audio_path'] = os.path.abspath(args.ref)
    want['prompt_text'] = args.prompt_text
    payload = {}
    alias = {
        'speed': 'speed_factor',
        'speed_factor': 'speed',
        'prompt_lang': 'prompt_language',
        'text_lang': 'text_language',
    }
    for k, v in want.items():
        if k in names:
            payload[k] = v
        elif alias.get(k) in names:
            payload[alias[k]] = v
    # 必填项缺失就直接报出来（别让服务端 422 再猜）
    missing = [k for k, meta in names.items() if meta.get('required') and k not in payload]
    return {'payload': payload, 'missing': missing}


def synth(base: str, args) -> dict:
    t0 = time.time()
    schema = discover(base)
    built = build_payload(schema, args)
    if built['missing']:
        return {'ok': False, 'error': '缺少必填参数: ' + ', '.join(built['missing']),
                'endpoint': schema['path'], 'params': sorted(schema['params'])}
    payload = built['payload']
    ct = next(iter(schema['params'].values())).get('ct') if schema['params'] else 'application/json'
    url = schema['base'] + schema['path']
    body = None
    headers = {}
    if schema['method'] == 'get':
        url = url + '?' + urllib.parse.urlencode({k: str(v).lower() if isinstance(v, bool) else v
                                                 for k, v in payload.items()})
    elif ct and 'json' in ct:
        body = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    else:
        body = urllib.parse.urlencode({k: str(v).lower() if isinstance(v, bool) else v
                                       for k, v in payload.items()}).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    req = urllib.request.Request(url, data=body, headers=headers, method=schema['method'].upper())
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            audio = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read()[:400].decode('utf-8', 'replace')
        return {'ok': False, 'error': f'HTTP {e.code}: {detail}', 'endpoint': schema['path'],
                'payload': payload}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}', 'endpoint': schema['path']}
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
        with open(args.out, 'wb') as f:
            f.write(audio)
    return {'ok': bool(audio), 'bytes': len(audio), 'ms': round((time.time() - t0) * 1000),
            'endpoint': schema['path'], 'payload': payload, 'out': args.out}


def main() -> int:
    ap = argparse.ArgumentParser(description='GPT-SoVITS 本地 API 客户端')
    ap.add_argument('--url', default='http://127.0.0.1:9880')
    ap.add_argument('--probe', action='store_true')
    ap.add_argument('--ref', default='')
    ap.add_argument('--prompt-text', default='')
    ap.add_argument('--say', default='')
    ap.add_argument('--out', default='')
    ap.add_argument('--no-emotion', action='store_true', help='不拼情感前缀')
    ap.add_argument('--split', default='', help='text_split_method（cut0=不切/cut5=按标点）')
    ap.add_argument('--frag', default='', help='fragment_interval（片段间静音秒数）')
    ap.add_argument('--steps', default='', help='sample_steps（v4 采样步数，越小越快）')
    ap.add_argument('--speed', default='', help='speed_factor 覆盖')
    a = ap.parse_args()

    if a.probe:
        try:
            schema = discover(a.url)
            print(json.dumps({'ok': True, 'base': schema['base'], 'endpoint': schema['path'],
                              'method': schema['method'],
                              'params': sorted(schema['params'])}, ensure_ascii=False, indent=2))
            return 0
        except Exception as e:
            print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}',
                              'hint': '本地 GPT-SoVITS 服务没起（或端口不是 9880）'},
                             ensure_ascii=False, indent=2))
            return 2

    if not (a.ref and a.prompt_text and a.say):
        ap.print_help()
        return 1
    if not a.no_emotion and not a.say.startswith('['):
        a.say = EMOTION_PREFIX + a.say
    # 命令行覆盖默认参数（便于对比实验）
    if a.split:   DEFAULTS['text_split_method'] = a.split
    if a.frag:    DEFAULTS['fragment_interval'] = float(a.frag)
    if a.steps:   DEFAULTS['sample_steps'] = int(a.steps)
    if a.speed:   DEFAULTS['speed_factor'] = float(a.speed)
    res = synth(a.url, a)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res.get('ok') else 4


if __name__ == '__main__':
    raise SystemExit(main())
