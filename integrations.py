"""Authenticated private calls and owner-managed Google Drive storage."""
import hashlib
import hmac
import json
import os
from urllib.parse import quote, unquote, urlparse
from uuid import UUID

import httpx
from fastapi import Depends, HTTPException, Request
from fastapi.responses import Response

MAX_UPLOAD = 25 * 1024 * 1024
DRIVE_KEYS = ('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_DRIVE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID')


def drive_configured():
    return all(os.getenv(key, '').strip() for key in DRIVE_KEYS)


def storage_proof(record):
    secret = os.getenv('STORAGE_SIGNING_KEY') or os.getenv('LIVEKIT_API_SECRET', '')
    if not secret:
        raise HTTPException(503, 'Configure a chave de assinatura dos arquivos.')
    fields = {key: record.get(key) for key in ('owner_id', 'channel_id', 'conversation_id', 'file_id', 'name', 'mime_type', 'size')}
    return hmac.new(secret.encode(), b'orbita-drive-v1:' + json.dumps(fields, sort_keys=True, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()


def install(app, current_user, settings, make_token):
    async def rows(table, headers, params):
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(settings()['SUPABASE_URL'] + '/rest/v1/' + table, headers=headers, params=params)
        if response.status_code != 200:
            raise HTTPException(503, 'Não foi possível consultar os dados da comunidade.')
        return response.json()

    async def scope(kind, target_id, user, headers):
        if kind not in ('channel', 'direct'):
            raise HTTPException(400, 'Destino inválido.')
        table = 'channels' if kind == 'channel' else 'conversations'
        found = await rows(table, headers, {'id': f'eq.{target_id}', 'select': '*'})
        if not found:
            raise HTTPException(404, 'Espaço inexistente ou sem acesso.')
        if kind == 'direct':
            convo = found[0]
            if user['id'] not in (convo['user_a'], convo['user_b']):
                raise HTTPException(404, 'Conversa sem acesso.')
            friends = await rows('friendships', headers, {'status': 'eq.accepted', 'or': f'(and(requester_id.eq.{convo["user_a"]},recipient_id.eq.{convo["user_b"]}),and(requester_id.eq.{convo["user_b"]},recipient_id.eq.{convo["user_a"]}))', 'select': 'id'})
            if not friends:
                raise HTTPException(403, 'Adicionem-se como amigos para continuar.')
        return found[0]

    @app.post('/api/conversations/{conversation_id}/join')
    async def private_join(conversation_id: UUID, identity=Depends(current_user)):
        user, headers = identity
        await scope('direct', conversation_id, user, headers)
        return make_token(user, f'direct-{conversation_id}')

    async def drive_token(client):
        if not drive_configured():
            raise HTTPException(503, 'O proprietário precisa conectar o Google Drive nas configurações do servidor.')
        response = await client.post('https://oauth2.googleapis.com/token', data={
            'client_id': os.environ['GOOGLE_CLIENT_ID'], 'client_secret': os.environ['GOOGLE_CLIENT_SECRET'],
            'refresh_token': os.environ['GOOGLE_DRIVE_REFRESH_TOKEN'], 'grant_type': 'refresh_token'})
        if response.status_code != 200:
            raise HTTPException(503, 'A autorização do Google Drive precisa ser renovada pelo proprietário.')
        return {'Authorization': 'Bearer ' + response.json()['access_token']}

    @app.post('/api/attachments')
    async def upload(request: Request, target_kind: str, target_id: UUID, identity=Depends(current_user)):
        user, headers = identity
        await scope(target_kind, target_id, user, headers)
        if not drive_configured():
            raise HTTPException(503, 'O Google Drive ainda não foi conectado pelo proprietário.')
        try:
            length = int(request.headers.get('content-length', '0'))
        except ValueError:
            raise HTTPException(400, 'Tamanho inválido.')
        if length > MAX_UPLOAD:
            raise HTTPException(413, 'O limite é de 25 MB por arquivo.')
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_UPLOAD:
                raise HTTPException(413, 'O limite é de 25 MB por arquivo.')
            body.extend(chunk)
        if not body:
            raise HTTPException(400, 'O arquivo está vazio.')
        name = unquote(request.headers.get('x-file-name', 'arquivo')).replace('\\', '/').split('/')[-1][:180]
        name = ''.join(c for c in name if ord(c) >= 32).strip() or 'arquivo'
        mime = request.headers.get('content-type', 'application/octet-stream').split(';')[0][:120]
        record = {'owner_id': user['id'], 'channel_id': str(target_id) if target_kind == 'channel' else None,
                  'conversation_id': str(target_id) if target_kind == 'direct' else None,
                  'name': name, 'mime_type': mime, 'size': len(body)}
        async with httpx.AsyncClient(timeout=90) as client:
            authorization = await drive_token(client)
            started = await client.post('https://www.googleapis.com/upload/drive/v3/files', params={'uploadType': 'resumable', 'fields': 'id'},
                headers={**authorization, 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': str(len(body))},
                json={'name': name, 'parents': [os.environ['GOOGLE_DRIVE_FOLDER_ID']], 'appProperties': {'app': 'orbita', 'owner': user['id']}})
            location = started.headers.get('location', '')
            parsed = urlparse(location)
            if started.status_code not in (200, 201) or parsed.scheme != 'https' or parsed.hostname != 'www.googleapis.com':
                raise HTTPException(502, 'O Drive recusou o upload. Confira a pasta e a autorização.')
            stored = await client.put(location, headers={**authorization, 'Content-Type': mime}, content=bytes(body))
            if stored.status_code not in (200, 201):
                raise HTTPException(502, 'Não foi possível armazenar o arquivo no Drive.')
            record['file_id'] = stored.json()['id']
            record['storage_proof'] = storage_proof(record)
            saved = await client.post(settings()['SUPABASE_URL'] + '/rest/v1/attachments',
                headers={**headers, 'Prefer': 'return=representation'}, json=record)
            if saved.status_code != 201:
                await client.delete('https://www.googleapis.com/drive/v3/files/' + quote(record['file_id'], safe=''), headers=authorization)
                raise HTTPException(502, 'Não foi possível registrar o arquivo na conversa.')
            return saved.json()[0]

    @app.get('/api/attachments/{attachment_id}/download')
    async def download(attachment_id: UUID, identity=Depends(current_user)):
        _user, headers = identity
        found = await rows('attachments', headers, {'id': f'eq.{attachment_id}', 'select': '*'})
        if not found:
            raise HTTPException(404, 'Arquivo inexistente ou sem acesso.')
        record = found[0]
        if not hmac.compare_digest(record.get('storage_proof', ''), storage_proof(record)):
            raise HTTPException(403, 'Registro de arquivo inválido.')
        async with httpx.AsyncClient(timeout=90) as client:
            authorization = await drive_token(client)
            async with client.stream('GET', 'https://www.googleapis.com/drive/v3/files/' + quote(record['file_id'], safe=''), params={'alt': 'media'}, headers=authorization) as response:
                if response.status_code != 200:
                    raise HTTPException(502, 'O arquivo está indisponível no Drive.')
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > MAX_UPLOAD:
                        raise HTTPException(502, 'O arquivo ultrapassa o limite permitido.')
                    content.extend(chunk)
        return Response(bytes(content), media_type='application/octet-stream', headers={
            'Content-Disposition': "attachment; filename*=UTF-8''" + quote(record['name'], safe=''),
            'Cache-Control': 'private, no-store'})

    @app.exception_handler(httpx.HTTPError)
    async def upstream_error(_request, _error):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content={'detail': 'A conexão com o serviço externo falhou. Tente novamente.'})
