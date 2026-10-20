"""Run locally, then authorize the owner's Drive in the browser. Never deploy this helper."""
import base64
import getpass
import hashlib
import hmac
import os
import secrets
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from dotenv import load_dotenv, set_key

ROOT = Path(__file__).resolve().parent
REDIRECT = 'http://127.0.0.1:8765/callback'


def main():
    load_dotenv(ROOT / '.env')
    print('Órbita · Conectar a pasta central do Google Drive')
    print('No cliente OAuth Web do Google, cadastre este retorno: ' + REDIRECT)
    client_id = os.getenv('GOOGLE_CLIENT_ID') or input('Client ID do seu aplicativo Google: ').strip()
    client_secret = os.getenv('GOOGLE_CLIENT_SECRET') or getpass.getpass('Client secret (entrada oculta): ').strip()
    if not client_id or not client_secret:
        raise RuntimeError('O cliente OAuth precisa estar configurado no Google Cloud.')
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Authorization codes must not appear in request logs.

        def do_GET(self):
            parsed = urlsplit(self.path)
            params = parse_qs(parsed.query)
            if parsed.path != '/callback':
                self.send_error(404)
                return
            if not hmac.compare_digest(params.get('state', [''])[0], state):
                self.send_error(400, 'Invalid authorization state')
                return
            result['code'] = params.get('code', [''])[0]
            result['error'] = params.get('error', [''])[0]
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write('<h1>Órbita</h1><p>Volte ao terminal para concluir. Você pode fechar esta aba.</p>'.encode())

    url = 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode({
        'client_id': client_id, 'redirect_uri': REDIRECT, 'response_type': 'code',
        'scope': 'https://www.googleapis.com/auth/drive.file', 'state': state,
        'access_type': 'offline', 'prompt': 'consent', 'code_challenge': challenge, 'code_challenge_method': 'S256'})
    with HTTPServer(('127.0.0.1', 8765), Callback) as server:
        server.timeout = 10
        print('Autorize sua própria conta Google no navegador. O acesso será aos arquivos criados pelo aplicativo.')
        webbrowser.open(url)
        import time
        deadline = time.monotonic() + 600
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if not result.get('code'):
        raise RuntimeError('Autorização cancelada ou expirada. Execute novamente para tentar de novo.')
    with httpx.Client(timeout=30) as client:
        token_response = client.post('https://oauth2.googleapis.com/token', data={
            'client_id': client_id, 'client_secret': client_secret, 'code': result['code'],
            'redirect_uri': REDIRECT, 'grant_type': 'authorization_code', 'code_verifier': verifier})
        if token_response.status_code != 200:
            raise RuntimeError('O Google recusou a autorização. Confira o cliente OAuth e a URL de retorno.')
        tokens = token_response.json()
        if not tokens.get('refresh_token'):
            raise RuntimeError('O Google não retornou autorização offline. Revogue o acesso deste aplicativo e tente de novo.')
        folder = client.post('https://www.googleapis.com/drive/v3/files', params={'fields': 'id'},
            headers={'Authorization': 'Bearer ' + tokens['access_token']},
            json={'name': 'Órbita · Arquivos', 'mimeType': 'application/vnd.google-apps.folder'})
        if folder.status_code not in (200, 201):
            raise RuntimeError('Não foi possível criar a pasta. Confira se a Google Drive API está ativada.')
    values = {'GOOGLE_CLIENT_ID': client_id, 'GOOGLE_CLIENT_SECRET': client_secret,
              'GOOGLE_DRIVE_REFRESH_TOKEN': tokens['refresh_token'], 'GOOGLE_DRIVE_FOLDER_ID': folder.json()['id']}
    for key, value in values.items():
        set_key(str(ROOT / '.env'), key, value)
    print('Pasta criada e autorização salva no .env local. Reinicie o site local para ativar.')
    print('Para o site publicado, copie somente as quatro variáveis GOOGLE do .env para o Environment do Render e publique novamente.')
    print('Não publique o .env no GitHub e não envie essas credenciais em conversas.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, httpx.HTTPError, OSError) as error:
        print('Não foi possível conectar o Drive:', type(error).__name__ if isinstance(error, httpx.HTTPError) else str(error))
        raise SystemExit(1)
