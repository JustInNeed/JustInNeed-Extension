#!/usr/bin/env python3
"""vis 대조 도구용 로컬 파일 서버 (#73).

실제 사이트(https)에 레포의 엔진 파일을 올리려면 페이지가 fetch 로 받아야 하는데,
python -m http.server 는 다른 출처 요청을 허락하는 헤더(CORS)를 안 붙인다. 그래서 따로 둔다.

  /cur/<경로>        = 이 작업 폴더의 파일 그대로 (새 코드)
  /old/<경로>?ref=main = git show <ref>:<경로> (옛 코드, 기본 ref = origin/main)
  /page/...          = 글 HTML 을 localhost 에서 열기 (아래 do_GET 주석)

쓰는 법: python3 tools/vis-compare/serve.py [포트=8761]
"""
import http.server
import re
import subprocess
import urllib.request
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8761


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, body, ctype='text/plain; charset=utf-8'):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    # 크롬 사설망 접근 검사(https 사이트 → localhost): 미리 묻는 요청에 허락 헤더를 준다
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        parts = u.path.lstrip('/').split('/', 1)
        if len(parts) != 2 or '..' in parts[1]:
            return self._send(404, b'not found')
        kind, rel = parts[0], urllib.parse.unquote(parts[1])
        ctype = 'text/javascript; charset=utf-8' if rel.endswith('.js') else 'text/plain; charset=utf-8'
        if kind == 'cur':
            f = ROOT / rel
            if not f.is_file():
                return self._send(404, ('없음: ' + rel).encode())
            return self._send(200, f.read_bytes(), ctype)
        if kind == 'page':
            # 진짜 사이트(https)는 localhost 로 가는 fetch 를 막는다(나무위키 11-10 확인). 그래서 글 HTML 을 여기서 받아
            # 사이트 스크립트를 빼고 <base> 로 원래 주소의 CSS · 그림을 쓰게 해서 localhost 에서 연다.
            #   /page/<저장한 HTML 경로>?url=<원래 주소>  또는  /page/-?url=<주소> (서버가 받아 옴)
            url = q.get('url', [''])[0]
            if rel == '-':
                # parse_qs 가 한글로 풀어 놓은 주소를 다시 % 로 (urllib 은 ASCII 주소만 받음)
                url = urllib.parse.quote(url, safe=":/?&=%#+,;@!$'()*[]~")
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Macintosh) vis-compare'})
                try:
                    html = urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'replace')
                except Exception as e:   # 실패 원문을 그대로 페이지에
                    return self._send(502, f'받아 오기 실패: {url}\n{e!r}'.encode())
            else:
                f = ROOT / rel
                if not f.is_file():
                    f = ROOT.parent / 'JustInNeed-Extension' / rel     # docs/ 는 git 밖이라 원래 폴더에만 있다
                if not f.is_file():
                    return self._send(404, ('없음: ' + rel).encode())
                html = f.read_text('utf-8', 'replace')
            html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S | re.I)
            html = re.sub(r'<meta[^>]+http-equiv=["\']?content-security-policy[^>]*>', '', html, flags=re.I)
            # crossorigin 붙은 <link rel=stylesheet> 는 사이트가 localhost 를 허락하지 않으면 안 실린다(나무위키) → 뗀다
            html = re.sub(r'(<link\b[^>]*?)\s+crossorigin(=["\'][^"\']*["\'])?', r'\1', html, flags=re.I)
            base = f'<base href="{url}">'
            html = re.sub(r'(<head[^>]*>)', r'\1' + base, html, count=1, flags=re.I) if re.search(r'<head', html, re.I) else base + html
            tag = f'<script src="http://localhost:{PORT}/cur/tools/vis-compare/compare.js"></script>'
            html = html.replace('</body>', tag + '</body>') if '</body>' in html else html + tag
            return self._send(200, html.encode('utf-8'), 'text/html; charset=utf-8')
        if kind == 'old':
            ref = q.get('ref', ['origin/main'])[0]
            r = subprocess.run(['git', '-C', str(ROOT), 'show', f'{ref}:{rel}'], capture_output=True)
            if r.returncode:
                return self._send(404, r.stderr)
            return self._send(200, r.stdout, ctype)
        return self._send(404, b'not found')

    def log_message(self, fmt, *args):
        sys.stderr.write('[vis-compare] ' + (fmt % args) + '\n')


if __name__ == '__main__':
    print(f'[vis-compare] {ROOT} 를 http://localhost:{PORT}/cur/ · /old/ 로 줌', flush=True)
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
