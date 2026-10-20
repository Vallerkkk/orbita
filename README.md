# Órbita

Site em português com backend Python/FastAPI, Supabase e LiveKit. Inclui cadastro/login, histórico paginado e mensagens ao vivo, salas de voz, câmera, tela e indicação de quem está falando. Layout responsivo, sem etapa de compilação do frontend.

## Configuração inicial

1. Instale Python 3.11 ou superior.
2. Crie um projeto no [Supabase](https://supabase.com/dashboard). Abra o **SQL Editor**, cole o conteúdo completo de `supabase.sql` e execute. O script prepara tabelas, canais iniciais, políticas de acesso e Realtime.
3. Em **Project Settings → API**, copie a URL do projeto e uma chave **publishable** (ou a chave legada `anon`). Não use `service_role` nem uma chave `sb_secret`.
4. Crie um projeto no [LiveKit Cloud](https://cloud.livekit.io/) ou use um servidor LiveKit próprio. Copie a URL `wss://`, API key e API secret.
5. Abra o `.env` já criado na pasta e preencha as cinco variáveis. Se precisar recriá-lo, copie `.env.example`. A URL do Supabase deve estar sem barra final. Não compartilhe nem publique o `.env`.
6. No Supabase Auth, habilite o provedor **Email**. Em **URL Configuration**, configure Site URL como `http://127.0.0.1:8000` durante o desenvolvimento. Para produção, use a URL HTTPS do seu site. Se a confirmação de e-mail estiver ligada, confirme o cadastro antes de entrar; configure o SMTP para envio real em produção.
7. Dê dois cliques em `iniciar.bat`. Na primeira vez, ele cria um ambiente isolado e instala as dependências. Abra **http://127.0.0.1:8000**. Não abra `index.html` diretamente.

Alternativa pelo terminal, na pasta do projeto:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
# Preencha .env antes de continuar.
.\.venv\Scripts\python.exe -m uvicorn app:app --reload
```

Após mudar `.env`, reinicie o servidor. Para atualizar dependências de um ambiente existente, execute novamente o comando de instalação. Não sobrescreva seu `.env` preenchido.

## Como testar com duas pessoas

- Crie duas contas em navegadores ou perfis diferentes; confirme os e-mails quando solicitado.
- Entre no canal `geral`, envie mensagens e confirme que aparecem na outra conta. Atualize a página para verificar o histórico.
- Entre na mesma sala de voz nas duas contas. Use fones para evitar eco; autorize o microfone. Ligue a câmera e compartilhe uma janela pelo botão de tela.
- A câmera começa desligada. Se o microfone for recusado, você ainda pode entrar para escutar.
- Para compartilhar tela, clique no botão e escolha a tela/janela/aba. O áudio da tela depende do navegador e da opção selecionada; esta versão publica o vídeo da tela, e o áudio da conversa vem do microfone.
- Fechar a aba ou sair da conta encerra a chamada. A mesma conta corresponde a uma identidade LiveKit: entrar por outra aba pode desconectar a chamada anterior.

## Estrutura e acesso

Esta é uma primeira versão com **uma comunidade compartilhada**: qualquer conta cadastrada pode ler todos os canais, conversar e entrar nas salas. A versão Social adiciona amizades, conversas privadas, anexos pelo Drive e criação de canais pela interface. A interface integrada inclui múltiplas comunidades públicas, enquetes, respostas e moderação por administradores. Ainda não inclui comunidades privadas com convites, cargos configuráveis, recuperação de senha ou gravação de chamadas. Também é possível criar canais pelo Supabase, preenchendo `name`, `kind` (`text` ou `voice`) e `position`; recarregue a página depois.

O navegador usa a chave pública e o JWT do usuário; as políticas RLS controlam o acesso. O Python valida o JWT no Supabase e consulta o canal com o mesmo JWT antes de emitir um token LiveKit de dez minutos, limitado à sala. Nenhuma chave administrativa do Supabase é necessária. O prazo do token limita a entrada inicial; ele não expulsa automaticamente participantes já conectados.

`app.py` serve o frontend e a rota de acesso às chamadas. `static/` contém a interface. `supabase.sql` prepara o banco. `tests/test_app.py` verifica autenticação, permissões e escopo do token com respostas simuladas.

## Publicação

Hospede o Python em um serviço que execute ASGI/FastAPI, configure as variáveis de ambiente no serviço e use HTTPS. Exemplo de comando: `python -m uvicorn app:app --host 0.0.0.0 --port 8000`. Ajuste a porta conforme o provedor. Mantenha as chaves LiveKit apenas no servidor. Atualize Site URL e redirects no Supabase Auth.

Microfone, câmera e tela precisam de contexto seguro: `localhost`/`127.0.0.1` para desenvolvimento ou HTTPS na internet. Acessar por um IP da rede sem HTTPS pode impedir a captura. O frontend carrega SDKs versionados de jsDelivr e fontes do Google; precisa de internet. LiveKit Cloud e Supabase têm limites e cobrança próprios. A hospedagem própria do LiveKit exige configurar TLS, portas de mídia e TURN conforme sua documentação.

## Problemas comuns

- **Site pede configuração:** preencha `.env` e reinicie.
- **Erro ao carregar comunidade:** execute `supabase.sql` e confira URL/chave pública.
- **Mensagens sem atualização ao vivo:** confira a publicação `supabase_realtime` da tabela `messages`. Reabra o canal após reconectar.
- **Chamadas indisponíveis:** confira as três variáveis `LIVEKIT_*`. Se a conexão for bloqueada na sua rede, revise a configuração TURN do servidor LiveKit.
- **Cadastro não envia e-mail:** confira SMTP, limites de envio e configuração de confirmação no Supabase.

Execute os testes com `.\.venv\Scripts\python.exe -m unittest discover -s tests -v`.

Referências: [Supabase Realtime](https://supabase.com/docs/guides/realtime/postgres-changes), [tokens LiveKit](https://docs.livekit.io/frontends/reference/tokens-grants/), [tela no LiveKit](https://docs.livekit.io/transport/media/screenshare/).

## Qualidade de vídeo

A câmera solicita até 1920×1080 a 30 fps, com teto de 4,5 Mbps. O compartilhamento de tela solicita até 1920×1080 a 30 fps, com teto de 6 Mbps e prioridade para preservar a resolução de textos. As metas dependem do navegador, câmera, capacidade do computador e da conexão. O LiveKit continua adaptando a transmissão e publica camadas menores para participantes com menos banda. As camadas adicionais de simulcast também consomem upload.

A tela compartilhada usa toda a largura da área de vídeo. O botão **Tela cheia** permite ampliar cada transmissão; a recepção adaptativa considera o tamanho da exibição e a densidade de pixels do monitor. Para aplicar os novos parâmetros, atualize a página, saia e entre novamente na chamada e reative a câmera ou a tela.


## Órbita Social

Interface renovada, amigos, mensagens e chamadas privadas, reações, perfil, redução de ruído e integração de arquivos/música com Google Drive. Execute a versão atual de `supabase.sql` para instalar as novas tabelas sem apagar o histórico. Veja `GOOGLE_DRIVE.md` para ativar os arquivos e o player compartilhado.


## Frontend integrado e administração

A interface fornecida em DEEPSEEK/INDEX.html foi integrada aos dados reais. Comunidades, enquetes, respostas, status e administração estão descritos em `ATUALIZACAO_FRONTEND.md`. O compartilhamento de tela agora solicita áudio, conforme suporte e autorização do navegador. O Drive pode receber cópias JSON dos dados públicos da comunidade após a autorização Google. O Firebase Performance Monitoring aguarda a configuração pública do projeto e a ativação opcional do usuário.
