# Conectar o Google Drive à Órbita

A versão Órbita Social usa uma pasta central do proprietário. O Supabase guarda contas, amizades, mensagens e permissões; o Drive guarda os arquivos. O player de música usa arquivos de áudio dessa mesma pasta.

## Configuração necessária

1. No [Google Cloud](https://console.cloud.google.com/), selecione ou crie um projeto e ative a **Google Drive API**.
2. Configure o consentimento OAuth do aplicativo, adicione sua conta como usuário de teste se necessário e crie um cliente OAuth do tipo **Aplicativo da Web**. Cadastre o retorno `http://127.0.0.1:8765/callback`.
3. Na pasta do site, execute `.\.venv\Scripts\python.exe conectar_drive.py`. Informe o Client ID e o Client secret diretamente no terminal local. O segredo fica oculto durante a digitação. Não envie esses valores em conversas.
4. O navegador abrirá a autorização Google. Autorize sua própria conta. A ferramenta usa o escopo `drive.file`, cria a pasta **Órbita · Arquivos** com essa autorização e salva as quatro variáveis Google no `.env` local. Uma pasta criada manualmente e apenas copiada pelo ID pode não estar acessível com esse escopo. Reinicie o servidor para usar o Drive localmente.
5. No Render, abra o serviço **orbita → Environment** e adicione:

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_DRIVE_REFRESH_TOKEN=
GOOGLE_DRIVE_FOLDER_ID=
```

6. Salve e publique novamente. O site passará a aceitar arquivos de até **25 MB** e músicas nos formatos aceitos pelo navegador.

Não coloque esses valores no GitHub nem no JavaScript. O Drive não recebe links públicos: cada download é autenticado no site e verificado conforme a conversa. A pasta central ocupa a cota da sua conta Google. Cada membro da comunidade poderá enviar arquivos para ela; mensagens diretas ficam disponíveis apenas aos dois participantes pelo site. O proprietário da conta Drive continua podendo ver todos os arquivos na própria conta.

Para produção, publique o consentimento OAuth conforme as regras do Google. Autorizações de aplicativos externos em modo de teste podem expirar; se isso ocorrer, será necessário autorizar novamente.

Opcionais: `STORAGE_SIGNING_KEY` fixa uma chave exclusiva de assinatura dos registros de arquivos. Na ausência dela, o servidor usa a chave LiveKit com um prefixo específico para arquivos. Depois de começar a armazenar arquivos, mantenha a chave de assinatura estável: alterá-la invalida as provas dos registros existentes.

## Funcionalidades desta versão

- Pedidos de amizade pelo @ do perfil, aceitar, recusar e remover.
- Conversas diretas e chamadas privadas de voz/vídeo, com verificação de amizade e participação no servidor.
- Canais de texto e voz, criação de canais, histórico paginado, reações, edição/exclusão das próprias mensagens e fixação das próprias mensagens.
- Perfil, presença online, microfone com redução de ruído, cancelamento de eco e ajuste automático de ganho, conforme suporte do navegador.
- Câmera e tela com metas de 1080p/30, adaptação à rede e tela cheia.
- Arquivos no Drive e player compartilhado com pausa, reprodução, posição sincronizada e volume local. A sincronização é aproximada; cada navegador precisa permitir a reprodução de áudio.

O FlaviBot funciona no Discord e não é integrado ao LiveKit. O player próprio foi a alternativa escolhida. Esta versão cobre as funções descritas acima; inclui agora comunidades públicas, enquetes, respostas e administração do site. Ainda não implementa cargos configuráveis, comunidades privadas, aplicativos ou escala do Discord. Autores podem fixar suas mensagens; administradores também moderam mensagens públicas. Remover uma amizade impede novas mensagens e novas entradas em chamadas, mas não desconecta uma chamada já em andamento. A pesquisa filtra as mensagens carregadas; use o botão de histórico para carregar mais.

## Verificação

Execute `python -m unittest discover -s tests -v` na pasta do projeto. Os testes cobrem autenticação, escopo dos tokens de chamada, bloqueio de terceiros, amizade obrigatória, limites de upload, assinatura dos arquivos e proteção das credenciais. A autorização e a transferência real do Drive precisam ser testadas depois que as credenciais Google forem configuradas.

Referências: [OAuth para aplicações Web](https://developers.google.com/identity/protocols/oauth2/web-server), [uploads do Drive](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [escopos do Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).


A interface integrada permite gerar uma cópia JSON dos dados públicos da comunidade pelo painel de administração. Leia `ATUALIZACAO_FRONTEND.md` para o escopo dessa cópia e os detalhes de Google Cloud.
