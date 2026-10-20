"""Site administration and authenticated Drive database snapshots."""
import json
import os
from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException


def firebase_config():
    try:
        config = json.loads(os.getenv('FIREBASE_WEB_CONFIG', '{}'))
    except (ValueError, TypeError):
        return None
    if not isinstance(config, dict) or not all(config.get(key) for key in ('apiKey', 'appId', 'projectId')):
        return None
    # This is the public web config, not an account credential or private key.
    allowed = ('apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId')
    return {key: str(config[key]) for key in allowed if key in config}


def install(app, current_user, settings):
    async def require_admin(identity=Depends(current_user)):
        user, headers = identity
        async with httpx.AsyncClient(timeout=15) as client:
            result = await client.get(settings()['SUPABASE_URL'] + '/rest/v1/site_roles', headers=headers,
                                      params={'user_id': 'eq.' + user['id'], 'select': 'role'})
        if result.status_code != 200:
            raise HTTPException(503, 'Não foi possível verificar a administração.')
        if not any(row.get('role') in ('creator', 'admin') for row in result.json()):
            raise HTTPException(403, 'Esta função é exclusiva dos administradores do site.')
        return user, headers

    @app.post('/api/admin/drive-backup')
    async def backup(identity=Depends(require_admin)):
        from integrations import drive_configured, MAX_UPLOAD
        _user, headers = identity
        if not drive_configured():
            raise HTTPException(503, 'Conecte o Drive primeiro: configure o aplicativo Google e execute conectar_drive.py.')
        export = {'format': 'orbita-community-database-v1', 'created_at': datetime.now(timezone.utc).isoformat(),
                  'scope': 'public community data; no authentication credentials or private conversations', 'consistency': 'best-effort snapshot; not a transactional backup', 'tables': {}}
        # Each query uses the caller's JWT. Private tables and auth schema are never exported here.
        async with httpx.AsyncClient(timeout=60) as client:
            for table in ('profiles', 'communities', 'channels', 'messages', 'site_roles', 'attachments', 'reactions', 'poll_votes', 'music_state'):
                records = []
                offset = 0
                for _page_number in range(200):
                    params = {'select': '*', 'order': 'id' if table != 'site_roles' else 'user_id', 'limit': 1000, 'offset': offset}
                    if table in ('attachments', 'music_state'):
                        params['channel_id'] = 'not.is.null'
                    if table in ('reactions', 'poll_votes'):
                        params['message_id'] = 'not.is.null'
                    result = await client.get(settings()['SUPABASE_URL'] + '/rest/v1/' + table, headers=headers, params=params)
                    if result.status_code != 200:
                        raise HTTPException(502, 'Não foi possível ler o banco para a cópia.')
                    page = result.json()
                    records.extend(page)
                    if len(json.dumps(records).encode()) > MAX_UPLOAD:
                        raise HTTPException(413, 'A cópia excede 25 MB. Exporte por comunidade para reduzir o tamanho.')
                    if not page:
                        break
                    offset += len(page)
                    if offset > 100000:
                        raise HTTPException(413, 'O banco excede o limite desta exportação.')
                else:
                    raise HTTPException(413, 'O banco excede o limite desta exportação.')
                export['tables'][table] = records
            body = json.dumps(export, ensure_ascii=False, separators=(',', ':')).encode()
            if len(body) > MAX_UPLOAD:
                raise HTTPException(413, 'A cópia excede o limite de 25 MB.')
            token = await client.post('https://oauth2.googleapis.com/token', data={
                'client_id': os.environ['GOOGLE_CLIENT_ID'], 'client_secret': os.environ['GOOGLE_CLIENT_SECRET'],
                'refresh_token': os.environ['GOOGLE_DRIVE_REFRESH_TOKEN'], 'grant_type': 'refresh_token'})
            if token.status_code != 200:
                raise HTTPException(503, 'A autorização do Drive precisa ser renovada.')
            authorization = {'Authorization': 'Bearer ' + token.json()['access_token']}
            boundary = 'orbita-' + os.urandom(12).hex()
            name = 'orbita-banco-' + datetime.now(timezone.utc).strftime('%Y-%m-%d-%H%M%S') + '.json'
            metadata = json.dumps({'name': name, 'mimeType': 'application/json',
                'parents': [os.environ['GOOGLE_DRIVE_FOLDER_ID']], 'appProperties': {'app': 'orbita', 'type': 'database-backup'}}).encode()
            multipart = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode() + metadata +
                f'\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n'.encode() + body + f'\r\n--{boundary}--\r\n'.encode())
            saved = await client.post('https://www.googleapis.com/upload/drive/v3/files', params={'uploadType': 'multipart', 'fields': 'id'},
                headers={**authorization, 'Content-Type': 'multipart/related; boundary=' + boundary}, content=multipart)
            if saved.status_code not in (200, 201):
                raise HTTPException(502, 'O Drive recusou a cópia do banco.')
        return {'message': 'Cópia JSON do banco da comunidade salva na pasta privada da Órbita no Drive.',
                'name': name, 'bytes': len(body)}

    @app.get('/api/admin/status')
    async def status(_identity=Depends(require_admin)):
        from integrations import drive_configured
        return {'driveConfigured': drive_configured(), 'firebaseConfigured': firebase_config() is not None,
                'hosting': 'Render', 'database': 'Supabase', 'media': 'LiveKit', 'paidGoogleServicesEnabled': False}
