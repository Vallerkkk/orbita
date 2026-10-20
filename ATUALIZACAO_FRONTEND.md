# Órbita — frontend integrado

O visual foi adaptado de `DEEPSEEK/INDEX.html`. O JavaScript de demonstração foi substituído pela integração do Supabase e LiveKit; usuários, histórico, contagens e chamadas fictícias não são usados em produção.

## Funções conectadas

- Comunidades abertas, criação e exploração; links para abrir a comunidade.
- Canais de texto, voz e vídeo; administração de canais pelo dono da comunidade ou pelos administradores do site.
- Amigos, pedidos, conversas e chamadas privadas.
- Respostas a mensagens, enquetes persistentes, um voto por pessoa, reações e formatação básica segura de texto.
- Perfil, status, aparência, densidade, notificações locais do navegador e redução de ruído do microfone.
- Participantes reais de salas públicas na barra lateral. Chamadas privadas não são identificadas na presença pública.
- Compartilhamento de tela com solicitação de áudio. No Brave/Chrome, selecione uma aba e marque **Compartilhar áudio** na janela do navegador. O suporte para som do sistema, janelas e telas depende do navegador e do sistema operacional. O site não consegue ativar uma fonte que o navegador não fornece.
- Administração de comunidades e moderação de mensagens públicas. O acesso de administrador não libera as conversas privadas de terceiros.

## Criadores

VallerJP foi vinculado pelo ID da conta existente como criador/administrador. Alterar o nome de exibição não transfere esse poder para outra conta.

Para Kalil, foi reservado um convite privado, de uso único e válido por sete dias. Após se cadastrar com o nome de exibição **Kalil**, ele deve abrir **Configurações → Aceitar convite de criador** e informar o código fornecido pelo proprietário. O código não está no GitHub nem no JavaScript público. Escolher o nome Kalil, sozinho, não concede poderes administrativos.

## Drive e banco

O Drive guarda arquivos e cópias JSON do banco da comunidade. O Supabase permanece como banco ativo de contas, mensagens e permissões, pois oferece as operações simultâneas e o controle de acesso necessários ao chat. O arquivo JSON no Drive é uma cópia de dados, não substitui essas funções nem é um backup transacional.

Depois da autorização Google, administradores podem usar **Google Cloud e arquivos → Salvar cópia do banco no Drive**. São incluídos perfis públicos, comunidades, canais, mensagens públicas, cargos, arquivos públicos, reações, votos e estado de música públicos. Conversas privadas, credenciais de autenticação e segredos do servidor não são exportados. O limite de cada cópia é 25 MB.

A autorização Google ainda é necessária. Veja `GOOGLE_DRIVE.md` e a ferramenta local `conectar_drive.py`. A pasta é privada na conta do proprietário; não são criados links públicos para os anexos.

## Google Cloud gratuito

Foi preparado o Firebase Performance Monitoring, com ativação opcional pelo usuário nas configurações Google do site. Para ativar o serviço é necessário registrar o aplicativo Web em um projeto Firebase e configurar no servidor `FIREBASE_WEB_CONFIG` com o JSON **público** fornecido pelo Firebase. Nunca coloque um JSON de conta de serviço ou uma chave privada nessa variável.

Não houve migração da hospedagem e não foram ativados serviços pagos do Google Cloud. O site continua em Render + Supabase + LiveKit. A configuração de recursos e credenciais Google depende da autorização do proprietário; o código não declara a integração ativa quando os dados não estão configurados.

## Validação

21 testes automatizados passaram. Consultas somente de leitura verificaram a função de administrador, bloqueio de autopromoção, proteção dos convites, acesso privado e validação das enquetes. A interface foi revisada no navegador com dados de demonstração. O teste que criaria contas temporárias em produção foi bloqueado pela revisão automática e não foi executado.

Uma chamada real entre dois dispositivos, áudio de tela entre participantes, transferência real pelo Drive e os dados recebidos pelo Firebase precisam ser verificados após a autorização/configuração Google e com dispositivos disponíveis.

O diagnóstico do Supabase mantém um aviso anterior de [proteção contra senhas vazadas desativada](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Essa preferência não foi alterada nesta atualização.
