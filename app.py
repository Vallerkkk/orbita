"""Órbita: comunidade com texto e chamadas. Execute: python -m uvicorn app:app --reload."""
import os
from datetime import timedelta
from pathlib import Path
from uuid import UUID

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from livekit import api
from integrations import install, drive_configured, MAX_UPLOAD
from admin_features import install as install_admin, firebase_config

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')
app = FastAPI(title='Órbita', docs_url=None, redoc_url=None)
bearer = HTTPBearer(auto_error=False)


def settings():
    return {key: os.getenv(key, '').strip() for key in (
        'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'LIVEKIT_URL',
        'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')}


@app.middleware('http')
async def headers(request, call_next):
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Permissions-Policy'] = 'camera=(self), microphone=(self), display-capture=(self)'
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/api/config')
def config():
    s = settings()
    ready = bool(s['SUPABASE_URL'] and s['SUPABASE_PUBLISHABLE_KEY'])
    return {'supabaseUrl': s['SUPABASE_URL'],
            'supabaseKey': s['SUPABASE_PUBLISHABLE_KEY'],
            'configured': ready,
            'firebaseConfig': firebase_config(),
            'driveConfigured': drive_configured(), 'uploadLimit': MAX_UPLOAD,
            'callsConfigured': all(s[k] for k in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'))}


async def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if credentials is None:
        raise HTTPException(401, 'Entre na sua conta para continuar.')
    s = settings()
    if not s['SUPABASE_URL'] or not s['SUPABASE_PUBLISHABLE_KEY']:
        raise HTTPException(503, 'Configure o Supabase no arquivo .env.')
    auth_headers = {'apikey': s['SUPABASE_PUBLISHABLE_KEY'],
                    'Authorization': f'Bearer {credentials.credentials}'}
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.get(s['SUPABASE_URL'] + '/auth/v1/user', headers=auth_headers)
    except httpx.HTTPError:
        raise HTTPException(503, 'Não foi possível consultar a autenticação.')
    if response.status_code != 200:
        raise HTTPException(401, 'Sua sessão expirou. Entre novamente.')
    user = response.json()
    if not user.get('id'):
        raise HTTPException(401, 'Sessão inválida.')
    return user, auth_headers


@app.post('/api/channels/{channel_id}/join')
async def join(channel_id: UUID, identity=Depends(current_user)):
    user, auth_headers = identity
    s = settings()
    if not all(s[k] for k in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')):
        raise HTTPException(503, 'Configure as três variáveis LIVEKIT no arquivo .env.')
    # Consulta com o JWT do usuário: as políticas RLS continuam sendo aplicadas.
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            response = await client.get(s['SUPABASE_URL'] + '/rest/v1/channels',
                headers=auth_headers, params={'id': f'eq.{channel_id}', 'select': 'id,kind'})
    except httpx.HTTPError:
        raise HTTPException(503, 'Não foi possível consultar o canal.')
    if response.status_code != 200:
        raise HTTPException(503, 'Verifique se o SQL do Supabase foi executado.')
    channels = response.json()
    if not channels:
        raise HTTPException(404, 'Canal inexistente ou sem acesso.')
    if channels[0]['kind'] != 'voice':
        raise HTTPException(400, 'Este canal é de texto.')
    return make_token(user, f'channel-{channel_id}')


def make_token(user, room_name):
    s = settings()
    if not all(s[k] for k in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')):
        raise HTTPException(503, 'As chamadas ainda não foram configuradas.')
    name = str(user.get('user_metadata', {}).get('display_name') or 'Participante')[:50]
    token = (api.AccessToken(s['LIVEKIT_API_KEY'], s['LIVEKIT_API_SECRET'])
        .with_identity(user['id']).with_name(name).with_ttl(timedelta(minutes=10))
        .with_grants(api.VideoGrants(room_join=True, room=room_name,
            can_publish=True, can_subscribe=True, can_publish_data=True)).to_jwt())
    return JSONResponse({'url': s['LIVEKIT_URL'], 'token': token})


@app.get('/')
def index():
    return FileResponse(ROOT / 'static' / 'index.html')


install(app, current_user, settings, make_token)
install_admin(app, current_user, settings)

app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
