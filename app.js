const $ = id => document.getElementById(id);
let db, config, session, channels = [], selected, signup = false;
let subscription, generation = 0, messages = new Map(), oldest, hasMore = false, loading = false;
let room, callChannel, joining = false, shuttingDown = false;
// Metas de qualidade: o navegador e o LiveKit podem reduzir conforme o dispositivo e a rede.
const CAMERA_CAPTURE = {resolution: {width:1920, height:1080, frameRate:30}};
const SCREEN_CAPTURE = {resolution: {width:1920, height:1080, frameRate:30}, contentHint:'detail'};
const CAMERA_PUBLISH = {videoEncoding: {maxBitrate:4_500_000, maxFramerate:30}, degradationPreference:'balanced'};

const SCREEN_PUBLISH = {screenShareEncoding: {maxBitrate:6_000_000, maxFramerate:30}, degradationPreference:'maintain-resolution'};

// ===== CALL ENHANCEMENTS =====
const participantVolumes = JSON.parse(localStorage.getItem('orbita-volumes') || '{}');
function getVolume(identity) { return participantVolumes[identity] ?? 1; }
function setVolume(identity, vol) {
  participantVolumes[identity] = Math.max(0, Math.min(1, +vol));
  localStorage.setItem('orbita-volumes', JSON.stringify(participantVolumes));
  document.querySelectorAll(`audio[data-participant="${CSS.escape(identity)}"]`).forEach(a => a.volume = participantVolumes[identity]);
}

const SCREEN_PRESETS = {
  '720p15': { resolution: {width:1280, height:720, frameRate:15}, bitrate: 1_500_000 },
  '1080p15': { resolution: {width:1920, height:1080, frameRate:15}, bitrate: 3_000_000 },
  '1080p30': { resolution: {width:1920, height:1080, frameRate:30}, bitrate: 5_000_000 },
  '1440p15': { resolution: {width:2560, height:1440, frameRate:15}, bitrate: 6_000_000 }
};
let currentScreenPreset = localStorage.getItem('orbita-screen-preset') || '1080p30';

function showReactionOverlay(participantId, emoji) {
  document.querySelectorAll(`.media-tile[data-participant="${CSS.escape(participantId)}"], .participant[data-participant="${CSS.escape(participantId)}"]`).forEach(tile => {
    const overlay = el('div', 'reaction-overlay', emoji);
    if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
    tile.append(overlay);
    setTimeout(() => overlay.remove(), 2800);
  });
}

document.addEventListener('keydown', e => {
  if (!room || e.target.matches('input, textarea, [contenteditable]')) return;
  if (e.key === 'm' || e.key === 'M') { e.preventDefault(); $('mic')?.click(); }
  if (e.key === 'v' || e.key === 'V') { e.preventDefault(); $('camera')?.click(); }
  if ((e.key === 's' || e.key === 'S') && e.shiftKey) { e.preventDefault(); $('screen')?.click(); }
  if (e.key === 'd' || e.key === 'D') { e.preventDefault(); $('deafen')?.click(); }
});

let toastTimer;
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 6500);
}
function el(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
}
function initials(name) { return [...(name || '?').trim()].slice(0, 2).join('').toUpperCase(); }
function errorText(error) {
  if (error?.name === 'NotAllowedError') return 'Permissão recusada. Autorize o dispositivo no navegador.';
  if (error?.name === 'NotFoundError') return 'Nenhum dispositivo compatível foi encontrado.';
  if (error?.message === 'Invalid login credentials') return 'E-mail ou senha incorretos.';
  if (error?.message === 'Email not confirmed') return 'Confirme seu e-mail antes de entrar.';
  return error?.message || 'Não foi possível concluir. Tente novamente.';
}

$('toggle-auth').onclick = () => {
  signup = !signup; $('name-label').hidden = !signup; $('display-name').required = signup;
  $('auth-title').textContent = signup ? 'Sua galera espera você.' : 'Bom ter você aqui.';
  $('auth-description').textContent = signup ? 'Crie uma conta e entre na conversa.' : 'Entre para encontrar a sua galera.';
  $('auth-submit').textContent = signup ? 'Criar minha conta ↗' : 'Entrar na Órbita ↗';
  $('toggle-auth').textContent = signup ? 'Já tem conta? Entre aqui' : 'Ainda não tem conta? Cadastre-se';
  $('password').autocomplete = signup ? 'new-password' : 'current-password'; $('auth-status').textContent = '';
};
$('auth-form').onsubmit = async event => {
  event.preventDefault(); if (!db) return;
  $('auth-submit').disabled = true; $('auth-status').textContent = '';
  try {
    const credentials = {email: $('email').value.trim(), password: $('password').value};
    const {data, error} = signup
      ? await db.auth.signUp({...credentials, options: {data: {display_name: $('display-name').value.trim()}}})
      : await db.auth.signInWithPassword(credentials);
    if (error) throw error;
    $('password').value = '';
    if (!data.session) $('auth-status').textContent = 'Confira seu e-mail para confirmar o cadastro. Depois, entre na sua conta.';
  } catch (error) { $('auth-status').textContent = errorText(error); }
  finally { $('auth-submit').disabled = false; }
};

async function showSession(next) {
  if (session?.user.id === next?.user.id && next) { session = next; return; }
  session = next;
  $('auth-view').hidden = !!next; $('app-view').hidden = !next;
  if (!next) {
    generation++; if (subscription) { db.removeChannel(subscription); subscription = null; }
    await leaveCall();
    for(const channel of [socialSubscription,presenceChannel,musicSubscription,extraSubscription])if(channel)db.removeChannel(channel);
    audioPlayer.pause();musicVersion++;people=[];friendships=[];conversations=[];
    if(musicUrl)URL.revokeObjectURL(musicUrl);musicUrl=null;audioPlayer.removeAttribute('src');return;
  }
  const name = next.user.user_metadata.display_name || 'Participante';
  $('user-name').textContent = name; $('user-avatar').textContent = initials(name);
  try {
    const {data, error} = await db.from('channels').select('*').order('position');
    if (error) throw error;
    if (!session || session.user.id !== next.user.id) return;
    channels = data;
    if (!data.length) {showFriends();return;}
    await initSocial(); renderChannels(); await selectChannel(channels.find(c => c.community_id===activeCommunity&&c.kind === 'text') || channels.find(c=>c.community_id===activeCommunity) || channels[0]);
  } catch (error) { toast('Não foi possível carregar a comunidade: ' + errorText(error)); }
}
$('logout').onclick = async () => {
  const {error} = await db.auth.signOut(); if (error) toast(errorText(error));
};
function renderChannels() {
  $('text-channels').replaceChildren(); $('voice-channels').replaceChildren();
  for (const channel of channels.filter(c=>c.community_id===activeCommunity)) {
    const button = el('button', 'channel' + (selected?.id === channel.id ? ' active' : '') + (callChannel?.id === channel.id ? ' connected' : ''));
    button.append(el('span', '', channel.kind === 'text' ? '#' : '◖'));
    button.append(document.createTextNode(channel.name));
    button.setAttribute('aria-pressed', String(selected?.id === channel.id));
    button.onclick = () => selectChannel(channel); $(channel.kind + '-channels').append(button);
    if(channel.kind==='voice'){const tree=el('div','voice-tree-live');for(const info of publicVoicePresence.filter(p=>p.channel_id===channel.id)){const p=person(info.id),row=el('div','voice-tree-person'),avatar=el('span','avatar',initials(p.display_name));avatar.style.background=p.avatar_color;row.append(avatar,el('span','',p.display_name),el('small','',info.screen?'AO VIVO':info.microphone?'◖':'🔇'));tree.append(row);}if(tree.children.length)$(channel.kind+'-channels').append(tree);}

  }
}
async function selectChannel(channel) {
  $('message-input').value = '';home=false;pinsOnly=false;
  $('friends-view').hidden=true;$('search-messages').value='';
  $('private-call').hidden=!channel.private||channel.kind!=='text';
  $('pins-toggle').setAttribute('aria-pressed','false');
  selected = channel;watchMusic(channel).catch(e=>toast(errorText(e))); const version = ++generation;
  if (subscription) { db.removeChannel(subscription); subscription = null; }
  renderChannels(); renderSocial(); $('channel-title').textContent = channel.name;
  $('text-view').hidden = channel.kind !== 'text'; $('voice-view').hidden = channel.kind !== 'voice';
  $('channel-description').textContent = channel.private?'Conversa privada · só vocês dois':channel.kind === 'text' ? 'O começo de boas conversas.' : 'Voz, vídeo e boas companhias.';
  if (channel.kind === 'voice') {
    $('voice-title').textContent = channel.name; updateCallUI(); return;
  }
  messages = new Map(); oldest = null; hasMore = false; loading = false; renderMessages();
  subscription = db.channel((channel.private?'direct-':'messages-') + channel.id + '-' + version)
    .on('postgres_changes', {event: '*', schema: 'public', table: messageTable(), filter: `${scopeKey(channel)}=eq.${channel.id}`}, async payload => {
      if(payload.eventType==='DELETE'){if(version===generation){messages.delete(payload.old.id);renderMessages();}return;}
      const {data, error} = await db.from(channel.private?'direct_messages':'messages').select(messageFields).eq('id', payload.new.id).single();
      if (version !== generation) return;
      if (error) { toast('Uma mensagem não pôde ser atualizada. Reabra o canal.'); return; }
      const list = $('message-list'); const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
      messages.set(data.id, data); renderMessages(nearBottom);
      if(data.author_id!==session?.user.id&&document.hidden&&'Notification'in window&&Notification.permission==='granted'&&profile?.presence_status!=='dnd')new Notification('Órbita',{body:channel.private?'Nova mensagem privada':'Nova mensagem em #'+channel.name,tag:'orbita-'+channel.id});
    }).on('postgres_changes',{event:'DELETE',schema:'public',table:channel.private?'direct_messages':'messages'},payload=>{
      if(version===generation&&messages.has(payload.old.id)){messages.delete(payload.old.id);renderMessages();}
    }).subscribe((status) => {
      if (version !== generation) return;
      if (status === 'SUBSCRIBED') loadMessages(version, true);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        toast('A conexão ao vivo falhou. Carregando o histórico; reabra o canal para reconectar.');
        loadMessages(version, true);
      }
    });
}
async function loadMessages(version, first = false) {
  if (loading || version !== generation) return;
  loading = true;
  try {
    let query = db.from(messageTable()).select(messageFields).eq(scopeKey(selected), selected.id)
      .order('created_at', {ascending:false}).order('id', {ascending:false}).limit(60);
    if (!first && oldest) query = query.or(`created_at.lt.${oldest.created_at},and(created_at.eq.${oldest.created_at},id.lt.${oldest.id})`);
    const {data, error} = await query;
    if (version !== generation) return;
    if (error) throw error;
    const list = $('message-list'), height = list.scrollHeight, top = list.scrollTop;
    data.forEach(m => messages.set(m.id, m)); oldest = data.at(-1) || oldest; hasMore = data.length === 60;
    renderMessages(first);
    if (!first) list.scrollTop = top + list.scrollHeight - height;
  } catch (error) { toast('Erro ao carregar mensagens: ' + errorText(error)); }
  finally { if (version === generation) loading = false; }
}
function renderMessages(scroll = false) {
  const list = $('message-list'), top = list.scrollTop; list.replaceChildren();
  const welcome = el('div', 'welcome'); welcome.append(el('div', 'welcome-icon', '#'),
    el('h1', '', (selected.private?'Sua conversa com ':'Bem-vindo a #') + selected.name), el('p', '', selected.private?'Mensagens e chamadas visíveis apenas para vocês dois.':'Um espaço para conversar, compartilhar e estar junto.'));
  list.append(welcome);
  if (hasMore) { const more = el('button', 'load-more', 'Carregar mensagens anteriores'); more.onclick = () => loadMessages(generation); list.append(more); }
  const sorted = [...messages.values()].sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const message of sorted) {
    if(pinsOnly&&!message.pinned)continue;
    const search=$('search-messages').value.trim().toLocaleLowerCase();
    if(search&&!message.content.toLocaleLowerCase().includes(search))continue;
    const name = message.profiles?.display_name || 'Participante';
    const item = el('article', 'message'), content = el('div', 'message-content'), meta = el('div', 'message-meta');
    const time = el('time', '', new Date(message.created_at).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}));
    time.dateTime = message.created_at; meta.append(el('strong', '', name), time);
    if(message.pinned)meta.append(el('small','pin-label','◆ Fixada'));
    content.append(meta);
    if(message.reply_to){const original=messages.get(message.reply_to);content.append(el('div','reply-card',original?(original.profiles?.display_name||'Participante')+': '+original.content.slice(0,150):'↪ Resposta a uma mensagem anterior'));}
    content.append(safeRichText(message.content));if(message.poll)content.append(renderPoll(message));
    if(message.attachments){const a=message.attachments;content.append(button('↓ '+a.name+' · '+(a.size/1024/1024).toFixed(1)+' MB',()=>downloadAttachment(a),'file-card'));}
    const actions=el('div','message-actions');actions.append(button('Responder',()=>replyToMessage(message),'tiny-button'));
    for(const emoji of ['👍','❤️','😂','🎉','🔥','👀']){const count=(message.reactions||[]).filter(r=>r.emoji===emoji).length;actions.append(button(emoji+(count?' '+count:''),()=>react(message,emoji),'reaction'));}
    if(message.author_id===session.user.id||(!selected.private&&isAdmin())){actions.append(button('Editar',()=>messageAction(message,'edit'),'tiny-button'),button(message.pinned?'Desafixar':'Fixar',()=>messageAction(message,'pin'),'tiny-button'),button('Excluir',()=>messageAction(message,'delete'),'tiny-button'));}
    content.append(actions);const avatar=el('div','avatar',initials(name));avatar.style.background=message.profiles?.avatar_color||'#8b80ff';
    item.append(avatar,content);list.append(item);
  }
  list.scrollTop = scroll ? list.scrollHeight : top;
}
$('message-input').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('message-form').requestSubmit(); }
};
$('message-form').onsubmit = async event => {
  event.preventDefault(); const content = $('message-input').value.trim();
  if (!content || !session || selected?.kind !== 'text' || $('send').disabled) return;
  const channelId = selected.id, version = generation; $('send').disabled = true;
  try {
    const {data, error} = await db.from(messageTable()).insert({[scopeKey(selected)]:channelId, author_id:session.user.id, content,reply_to:replyTarget?.scope===channelId?replyTarget.id:null}).select(messageFields).single();
    if (error) throw error;
    if ($('message-input').value.trim() === content) $('message-input').value = '';replyTarget=null;$('reply-banner').classList.add('hidden');
    if (version === generation) { messages.set(data.id, data); renderMessages(true); }
  } catch (error) { toast(errorText(error)); }
  finally { $('send').disabled = false; }
};

function onTrack(track, participant) {
  if (track.kind === 'video' && document.querySelector(`[data-track="${track.sid}"]`)) return;
  const media = track.attach(); media.dataset.track = track.sid;
  if (track.kind === 'video') {
    const isScreen = track.source === 'screen_share';
    const figure = el('figure', 'media-tile' + (isScreen ? ' media-screen' : '')); figure.dataset.track = track.sid;
    media.muted = true; media.playsInline = true;
    const caption = el('figcaption');
    caption.append(el('span', '', (participant.name || 'Participante') + (isScreen ? ' · Tela' : ' · Câmera')));
    const expand = el('button', 'expand-video', 'Tela cheia');
    expand.type = 'button'; expand.setAttribute('aria-label', `Ver ${isScreen ? 'tela' : 'câmera'} de ${participant.name || 'Participante'} em tela cheia`);
    expand.onclick = async () => {
      try {
        if (document.fullscreenElement === figure) await document.exitFullscreen();
        else if (figure.requestFullscreen) await figure.requestFullscreen();
        else if (media.webkitEnterFullscreen) media.webkitEnterFullscreen();
        else toast('Este navegador não oferece tela cheia para este vídeo.');
      } catch (error) { toast(errorText(error)); }
    };
    // Volume control for remote audio of this participant
    if (!participant.isLocal) {
      const volWrap = el('label', 'tile-volume');
      const vol = el('input'); vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.05;
      vol.value = getVolume(participant.identity || participant.sid);
      vol.title = 'Volume';
      vol.oninput = () => setVolume(participant.identity || participant.sid, vol.value);
      volWrap.append(document.createTextNode('🔊 '), vol);
      caption.append(volWrap);
    }
    // PiP button for main tiles
    const pip = el('button', 'pip-btn', 'PiP');
    pip.type = 'button';
    pip.onclick = () => media.requestPictureInPicture?.().catch(() => toast('PiP não suportado'));
    caption.append(pip);
    caption.append(expand);
    figure.dataset.participant = participant.identity || participant.sid;
    if (participant.isLocal) figure.dataset.local = 'true';
    figure.append(media, caption);
    $('media-grid').append(figure);
    if (participant.isLocal) applyMirror();
    updateMediaLayout();
  } else {
    // Áudio (microfone ou áudio da tela)
    media.dataset.remoteAudio = 'true';
    media.dataset.participant = participant.identity || participant.sid;
    media.muted = deafened;
    media.volume = getVolume(participant.identity || participant.sid);
    media.autoplay = true;
    media.playsInline = true;
    document.body.append(media);
    media.play().catch(() => {});
  }
}
function removeTrack(track) {
  track.detach().forEach(node => { const tile = node.closest('.media-tile'); if (tile) tile.remove(); else node.remove(); });
  updateMediaLayout();
}
function updateCallUI() {
  const here = !!room && callChannel?.id === selected?.id && selected?.kind === 'voice';
  $('call-dock').hidden=!room;$('dock-name').textContent=callChannel?.name||'';
  $('join-call').hidden = here; $('join-call').disabled = joining || !config?.callsConfigured;
  $('join-call').textContent = joining ? 'Conectando…' : (room ? 'Trocar para esta sala ↗' : 'Entrar na sala ↗');
  $('active-controls').hidden = !here; $('empty-call').hidden = here;
  $('call-status').textContent = !config?.callsConfigured ? 'As chamadas precisam das credenciais LIVEKIT no .env.'
    : here ? 'Você está conectado. Sua câmera começa desligada.'
    : room ? `Você continua conectado em ${callChannel.name}.` : 'Entre na sala e faça parte da conversa.';
  $('participants').hidden = !here; $('media-grid').hidden = !here; updateMediaLayout();
  $('participants').replaceChildren();
  $('voice-stage').setAttribute('aria-label',here?'Chamada conectada':'Sala de voz');
  publishVoicePresence().catch(()=>{});
  if (room) {
    const participants = [room.localParticipant, ...room.remoteParticipants.values()];
    for (const participant of participants) {
      const card = el('div', 'participant' + (participant.isSpeaking ? ' speaking speaking-ring' : ''));
      card.dataset.participant = participant.identity || participant.sid;
      // Connection quality badge
      const q = participant.connectionQuality || 'unknown';
      const badge = el('span', 'quality-badge q-' + q, q === 'excellent' ? '●' : q === 'good' ? '●' : '●');
      badge.title = 'Qualidade: ' + q;
      card.append(badge);
      card.append(el('span', 'avatar', initials(participant.name)), el('strong', '', participant.name || 'Participante'),
        el('small', '', participant.isMicrophoneEnabled ? 'Microfone ligado' : 'Microfone desligado'));
      $('participants').append(card);
    }
    for (const [id, enabled] of [['mic',room.localParticipant.isMicrophoneEnabled],['camera',room.localParticipant.isCameraEnabled],['screen',room.localParticipant.isScreenShareEnabled]]) {
      $(id).setAttribute('aria-pressed', String(enabled));
    }
  }
  renderChannels();
}
async function leaveCall() {
  const previous = room; room = null; callChannel = null;
  if (previous) { previous.removeAllListeners(); await previous.disconnect(); }
  document.querySelectorAll('[data-remote-audio]').forEach(node => node.remove());
  $('media-grid').replaceChildren(); updateCallUI();
}
$('join-call').onclick = async () => {
  if (joining || !session || selected?.kind !== 'voice') return;
  joining = true; updateCallUI(); const target = selected;
  try {
    const {data: {session: fresh}} = await db.auth.getSession();
    if (!fresh) throw Error('Sua sessão expirou. Entre novamente.');
    const response = await fetch(`/api/${target.private?'conversations':'channels'}/${target.id}/join`, {method:'POST', headers:{Authorization:`Bearer ${fresh.access_token}`}});
    const result = await response.json(); if (!response.ok) throw Error(result.detail || 'Não foi possível entrar.');
    const {Room, RoomEvent, VideoPresets, ScreenSharePresets} = await import('https://cdn.jsdelivr.net/npm/livekit-client@2.15.6/+esm');
    if (!session || shuttingDown) return;
    await leaveCall();
    const connected = new Room({
      adaptiveStream: {pixelDensity:'screen'},
      dynacast:true,
      audioCaptureDefaults:audioCapture(),
      videoCaptureDefaults:CAMERA_CAPTURE,
      publishDefaults: {
        simulcast:true,
        videoCodec:'vp8',
        videoEncoding:CAMERA_PUBLISH.videoEncoding,
        screenShareEncoding:SCREEN_PUBLISH.screenShareEncoding,
        videoSimulcastLayers:[VideoPresets.h360, VideoPresets.h720],
        screenShareSimulcastLayers:[ScreenSharePresets.h720fps15],
      },
    }); room = connected; callChannel = target;
    connected.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => onTrack(track, participant)).on(RoomEvent.TrackUnsubscribed, removeTrack)
      .on(RoomEvent.LocalTrackPublished, publication => { if (publication.track?.kind === 'video') onTrack(publication.track, connected.localParticipant); updateCallUI(); })
      .on(RoomEvent.LocalTrackUnpublished, publication => {
        if (publication.track) removeTrack(publication.track);
        document.querySelectorAll(`[data-track="${publication.trackSid}"]`).forEach(node => node.remove());
        updateCallUI();
      });
    for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.ActiveSpeakersChanged]) connected.on(event, updateCallUI);
    connected.on(RoomEvent.DataReceived,receiveCallData);
    connected.on(RoomEvent.ConnectionQualityChanged,updateCallUI);
    connected.on(RoomEvent.Reconnecting, () => { $('call-status').textContent = 'Reconectando à sala…'; });
    connected.on(RoomEvent.Reconnected, updateCallUI);
    connected.on(RoomEvent.Disconnected, () => { if (room === connected) { leaveCall(); toast('Você saiu da chamada.'); } });
    await connected.connect(result.url, result.token);
    if (!session || room !== connected) { await connected.disconnect(); return; }
    await connected.startAudio();
    try { await connected.localParticipant.setMicrophoneEnabled(true, audioCapture()); }
    catch (error) { toast('Você entrou sem microfone. ' + errorText(error)); }
  } catch (error) { await leaveCall(); toast(errorText(error)); }
  finally { joining = false; updateCallUI(); }
};
$('leave-call').onclick = () => leaveCall();
for (const [id, property, method] of [['mic','isMicrophoneEnabled','setMicrophoneEnabled'],['camera','isCameraEnabled','setCameraEnabled'],['screen','isScreenShareEnabled','setScreenShareEnabled']]) {
  $(id).onclick = async () => {
    if (!room) return; $(id).disabled = true;
    try {
      const enabled = !room.localParticipant[property];
      if (id === 'camera') await room.localParticipant.setCameraEnabled(enabled, CAMERA_CAPTURE, CAMERA_PUBLISH);
      else if (id === 'screen') {
        if (enabled) {
          const preset = SCREEN_PRESETS[currentScreenPreset] || SCREEN_PRESETS['1080p30'];
          const captureOpts = {
            resolution: preset.resolution,
            contentHint: 'detail',
            audio: screenCheck.checked,
            systemAudio: screenCheck.checked ? 'include' : 'exclude',
            surfaceSwitching: 'include',
            selfBrowserSurface: 'exclude',
            suppressLocalAudioPlayback: true
          };
          const publishOpts = {
            screenShareEncoding: { maxBitrate: preset.bitrate, maxFramerate: preset.resolution.frameRate },
            degradationPreference: 'maintain-resolution'
          };
          await room.localParticipant.setScreenShareEnabled(true, captureOpts, publishOpts);
          setTimeout(() => {
            const hasAudio = [...room.localParticipant.audioTrackPublications.values()].some(p => p.source === 'screen_share_audio');
            if (screenCheck.checked && !hasAudio) {
              toast('Áudio da tela não capturado. Selecione uma ABA e marque "Compartilhar áudio da aba" na janela do navegador.');
            }
          }, 800);
        } else {
          await room.localParticipant.setScreenShareEnabled(false);
        }
      }
      else await room.localParticipant[method](enabled, audioCapture());
    }
    catch (error) { toast(errorText(error)); }
    finally { $(id).disabled = false; updateCallUI(); }
  };
}
window.addEventListener('pagehide', () => { shuttingDown = true;audioPlayer.pause();if(presenceChannel)presenceChannel.untrack(); if (room) room.disconnect(); });
window.addEventListener('pageshow', () => { shuttingDown = false; });



// Mirror local camera
let mirrorLocal = localStorage.getItem('orbita-mirror') !== 'false';
function applyMirror() {
  document.querySelectorAll('.media-tile[data-local="true"] video').forEach(v => v.classList.toggle('mirror', mirrorLocal));
}


let layoutTimer;
function updateMediaLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(doUpdateMediaLayout, 50);
}
function doUpdateMediaLayout() {
  const stage = $('voice-stage');
  const main = $('main-stage');
  const screens = [...document.querySelectorAll('.media-screen')];
  const hasScreen = screens.length > 0;
  const mode = localStorage.getItem('orbita-layout') || 'stage';
  stage.classList.toggle('stage-mode', hasScreen && mode === 'stage');
  stage.classList.toggle('gallery-mode', !hasScreen || mode === 'gallery');
  $('layout-toggle').hidden = !hasScreen;
  $('layout-toggle').textContent = mode === 'stage' ? 'Ver Gallery' : 'Ver Stage';
  if (hasScreen && mode === 'stage') {
    // Move primary screen to main stage
    if (screens[0].parentElement !== main) {
      main.replaceChildren(screens[0]);
    }
  } else {
    // Return all to media-grid
    if (main.firstElementChild) $('media-grid').append(main.firstElementChild);
    main.replaceChildren();
  }
}

$('layout-toggle')?.addEventListener('click', () => {
  const current = localStorage.getItem('orbita-layout') || 'stage';
  localStorage.setItem('orbita-layout', current === 'stage' ? 'gallery' : 'stage');
  updateMediaLayout();
});

async function boot() {
  try {
    config = await (await fetch('/api/config')).json();
    if (!config.configured) { $('setup').hidden = false; $('auth-submit').disabled = true; return; }
    const {createClient} = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm');
    db = createClient(config.supabaseUrl, config.supabaseKey);
    // Não execute chamadas ao Supabase dentro do callback de Auth.
    db.auth.onAuthStateChange((_event, next) => { setTimeout(() => showSession(next), 0); });
    const {data, error} = await db.auth.getSession(); if (error) throw error;
    await showSession(data.session);startGooglePerformance();
  } catch (error) { $('auth-status').textContent = 'Falha ao iniciar: ' + errorText(error); $('auth-submit').disabled = true; }
}
// Social features share the authenticated Supabase client and its row policies.
let profile, people = [], friendships = [], conversations = [], socialSubscription, presenceChannel;
let publicVoicePresence=[],lastPresenceSignature='',online = new Set(), home = false, pinsOnly = false, musicSubscription, musicState, musicUrl, musicVersion = 0, musicRevision = 0;
const audioPlayer = new Audio();
let noise = localStorage.getItem('orbita-noise') !== 'false', deafened = false;

// Wire screen quality selector
if ($('screen-quality')) {
  $('screen-quality').value = currentScreenPreset;
  $('screen-quality').onchange = () => {
    currentScreenPreset = $('screen-quality').value;
    localStorage.setItem('orbita-screen-preset', currentScreenPreset);
    toast('Qualidade da tela: ' + currentScreenPreset);
  };
}
// Noise toggle
if ($('noise-toggle')) {
  const updateNoiseBtn = () => {
    $('noise-toggle').textContent = noise ? '🔇 Noise ON' : '🔇 Noise OFF';
    $('noise-toggle').classList.toggle('primary', noise);
  };
  updateNoiseBtn();
  $('noise-toggle').onclick = async () => {
    noise = !noise;
    localStorage.setItem('orbita-noise', String(noise));
    updateNoiseBtn();
    if (room) {
      try {
        for (const pub of room.localParticipant.audioTrackPublications.values()) {
          if (pub.track?.source === 'microphone') await pub.track.restartTrack(audioCapture());
        }
        toast(noise ? 'Noise suppression ativado' : 'Noise suppression desativado');
      } catch (e) { toast(errorText(e)); }
    }
  };
}
// Show call-extras when in call
const origUpdateCallUI = updateCallUI;
updateCallUI = function() {
  origUpdateCallUI();
  const here = !!room && callChannel?.id === selected?.id && selected?.kind === 'voice';
  if ($('call-extras')) $('call-extras').hidden = !here;
  if ($('shortcuts-hint')) $('shortcuts-hint').hidden = !here;
};


const audioCapture = () => ({noiseSuppression:noise, echoCancellation:true, autoGainControl:true, channelCount:1});
const scopeKey = target => target?.private ? 'conversation_id' : 'channel_id';
const messageTable = () => selected?.private ? 'direct_messages' : 'messages';
const messageFields = '*,profiles!author_id(display_name,username,avatar_color),attachments(id,name,mime_type,size),reactions(id,emoji,user_id),poll_votes(id,user_id,option_index)';
const otherUser = c => c.user_a === session.user.id ? c.user_b : c.user_a;
const person = id => people.find(p => p.id === id) || {id,display_name:'Participante',username:'',avatar_color:'#8b80ff'};
function button(label, action, css = 'soft-button') { const b = el('button', css, label); b.type='button'; b.onclick=()=>Promise.resolve(action()).catch(e=>toast(errorText(e))); return b; }
async function checked(query) { const result=await query; if(result.error) throw result.error; return result.data; }
async function apiFetch(path, options={}) {
  const {data:{session:fresh}}=await db.auth.getSession();
  if(!fresh) throw Error('Entre novamente na sua conta.');
  const response=await fetch(path,{...options,headers:{...options.headers,Authorization:`Bearer ${fresh.access_token}`}});
  if(!response.ok) {const error=await response.json().catch(()=>({}));throw Error(error.detail||'Não foi possível concluir.');}
  return response;
}
function showDialog(title, build) {
  $('dialog-title').textContent=title; $('dialog-content').replaceChildren(); build($('dialog-content')); $('app-dialog').showModal();
}
function inputField(parent,label,value,max=160) {
  const l=el('label','field',label), input=el('input'); input.value=value||'';input.maxLength=max;l.append(input);parent.append(l);return input;
}
async function loadSocial() {
  const userId=session?.user.id;if(!userId)return;
  const results=await Promise.all([
    checked(db.from('profiles').select('*').order('display_name')),
    checked(db.from('friendships').select('*')),
    checked(db.from('conversations').select('*').order('created_at',{ascending:false}))]);
  if(session?.user.id!==userId)return;[people,friendships,conversations]=results;
  profile=person(session.user.id); $('user-name').textContent=profile.display_name;
  $('user-avatar').textContent=initials(profile.display_name);$('user-avatar').style.background=profile.avatar_color;
  renderSocial();renderMembers();if(home)renderFriends();
}
async function initSocial() {
  await loadSocial();
  if(socialSubscription) await db.removeChannel(socialSubscription);
  socialSubscription=db.channel('social-'+session.user.id)
    .on('postgres_changes',{event:'*',schema:'public',table:'friendships'},()=>loadSocial().catch(e=>toast(errorText(e))))
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'conversations'},()=>loadSocial().catch(e=>toast(errorText(e))))
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'profiles'},()=>loadSocial().catch(e=>toast(errorText(e))))
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'channels'},async()=>{channels=await checked(db.from('channels').select('*').order('position'));renderChannels();})
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'call_events'},payload=>incomingCall(payload.new))
    .on('postgres_changes',{event:'*',schema:'public',table:'reactions'},()=>{if(!home&&selected?.kind==='text')refreshMessages();})
    .subscribe();
  if(presenceChannel) await db.removeChannel(presenceChannel);
  presenceChannel=db.channel('community:main',{config:{private:true,presence:{key:session.user.id}}});
  presenceChannel.on('presence',{event:'sync'},()=>{publicVoicePresence=Object.entries(presenceChannel.presenceState()).flatMap(([id,metas])=>metas.map(meta=>({...meta,id})));online=new Set(Object.keys(presenceChannel.presenceState()));renderMembers();renderChannels();if(home)renderFriends();});
  presenceChannel.subscribe(async status=>{if(status==='SUBSCRIBED')await publishVoicePresence(true);});
}
function renderMembers() {
  $('member-count').textContent=String(people.length); $('member-list').replaceChildren();
  const ordered=[...people].sort((a,b)=>Number(online.has(b.id))-Number(online.has(a.id)));
  for(const p of ordered){
    const row=el('div','member');row.dataset.userId=p.id;const a=el('span','avatar',initials(p.display_name));a.style.background=p.avatar_color;
    const content=el('div');content.append(el('strong','',p.display_name),el('small','',online.has(p.id)?'● Disponível':'Offline'));
    row.append(a,content);row.onclick=()=>showProfile(p);$('member-list').append(row);
  }
  $('online-count').textContent=online.size+' online';
}
function renderSocial() {
  $('dm-channels').replaceChildren();
  const pending=friendships.filter(f=>f.status==='pending'&&f.recipient_id===session.user.id).length;
  $('friends-badge').textContent=pending||'';
  for(const c of conversations){const p=person(otherUser(c));const b=button('@ '+p.display_name,()=>openConversation(c),'channel'+(selected?.private&&selected.id===c.id?' active':''));$('dm-channels').append(b);}
}
function showFriends() {
  home=true;generation++;if(subscription){db.removeChannel(subscription);subscription=null;}
  $('friends-view').hidden=false;$('text-view').hidden=true;$('voice-view').hidden=true;
  $('channel-title').textContent='Amigos';$('channel-description').textContent='Sua galera, sempre por perto.';
  $('private-call').hidden=true;renderFriends();
}
function renderFriends() {
  $('friends-list').replaceChildren();
  const accepted=friendships.filter(f=>f.status==='accepted'), pending=friendships.filter(f=>f.status==='pending');
  $('friend-total').textContent=accepted.length+(accepted.length===1?' amigo':' amigos');
  for(const f of [...pending,...accepted].filter(f=>f.status==='pending'||friendsFilter!=='online'||online.has(f.requester_id===session.user.id?f.recipient_id:f.requester_id))) {
    const p=person(f.requester_id===session.user.id?f.recipient_id:f.requester_id), row=el('article','friend-card');
    const avatar=el('span','avatar',initials(p.display_name));avatar.style.background=p.avatar_color;
    const info=el('div','friend-info');info.append(el('strong','',p.display_name),el('small','', '@'+p.username+' · '+(f.status==='accepted'?(online.has(p.id)?'Online':'Offline'):(f.recipient_id===session.user.id?'Quer ser seu amigo':'Pedido enviado'))));
    row.append(avatar,info);
    if(f.status==='accepted'){
      row.append(button('Mensagem',()=>startConversation(p)),button('Ligar',()=>startConversation(p,true)),button('Remover',()=>removeFriend(f),'text-button'));
    }else{
      if(f.recipient_id===session.user.id)row.append(button('Aceitar',async()=>{await checked(db.from('friendships').update({status:'accepted'}).eq('id',f.id));await loadSocial();},'primary'));
      row.append(button(f.recipient_id===session.user.id?'Recusar':'Cancelar',()=>removeFriend(f),'text-button'));
    }
    $('friends-list').append(row);
  }
  if(!friendships.length)$('friends-list').append(el('p','empty-state','As boas conversas começam com um oi. Adicione alguém pelo nome de usuário.'));
}
async function removeFriend(f){
  showDialog('Remover conexão',container=>{container.append(el('p','','A amizade será removida. O histórico continua disponível, mas novas mensagens e chamadas exigirão uma nova amizade.'));
    container.append(button('Confirmar',async()=>{await checked(db.from('friendships').delete().eq('id',f.id));$('app-dialog').close();await loadSocial();},'danger'));});
}
function showProfile(p) {
  showDialog(p.display_name,container=>{
    container.append(el('p','muted','@'+p.username),el('p','',p.bio||'Ainda sem biografia.'));
    if(p.id===session.user.id)return;
    const f=friendships.find(f=>[f.requester_id,f.recipient_id].includes(p.id));
    if(f?.status==='accepted')container.append(button('Enviar mensagem',async()=>{$('app-dialog').close();await startConversation(p);},'primary'));
    else if(!f)container.append(button('Adicionar amigo',async()=>{await sendFriend(p);$('app-dialog').close();},'primary'));
    else container.append(el('p','muted','Pedido de amizade pendente.'));
  });
}
async function sendFriend(p){
  if(p.id===session.user.id)throw Error('Esse é o seu próprio perfil.');
  await checked(db.from('friendships').insert({requester_id:session.user.id,recipient_id:p.id}));toast('Pedido de amizade enviado.');await loadSocial();
}
$('add-friend-form').onsubmit=async event=>{
  event.preventDefault();try{const username=$('friend-username').value.trim().replace(/^@/,'').toLowerCase();
    const p=people.find(p=>p.username===username);if(!p)throw Error('Usuário não encontrado. Peça o @ do perfil da pessoa.');await sendFriend(p);$('friend-username').value='';
  }catch(e){toast(errorText(e));}
};
async function startConversation(p,call=false){
  let c=conversations.find(c=>otherUser(c)===p.id);
  if(!c){const [user_a,user_b]=[session.user.id,p.id].sort();const result=await db.from('conversations').insert({user_a,user_b}).select().single();
    if(result.error&&result.error.code==='23505')c=await checked(db.from('conversations').select('*').eq('user_a',user_a).eq('user_b',user_b).single());
    else {if(result.error)throw result.error;c=result.data;}await loadSocial();}
  await openConversation(c,call);
  if(call){await checked(db.from('call_events').insert({conversation_id:c.id,caller_id:session.user.id}));$('join-call').click();}
}
async function openConversation(c,voice=false){const p=person(otherUser(c));await selectChannel({id:c.id,name:p.display_name,kind:voice?'voice':'text',private:true,friend:p});renderSocial();}
$('private-call').onclick=()=>{const c=conversations.find(c=>c.id===selected?.id);if(c)startConversation(person(otherUser(c)),true).catch(e=>toast(errorText(e)));};
function incomingCall(event){
  if(event.caller_id===session?.user.id||Date.now()-Date.parse(event.created_at)>60000)return;
  const p=person(event.caller_id);$('incoming-name').textContent=p.display_name+' está chamando…';$('incoming-call').hidden=false;
  $('answer-call').onclick=async()=>{try{const c=await checked(db.from('conversations').select('*').eq('id',event.conversation_id).single());$('incoming-call').hidden=true;await openConversation(c,true);$('join-call').click();}catch(e){toast(errorText(e));}};
  setTimeout(()=>{$('incoming-call').hidden=true;},30000);
}
$('decline-call').onclick=()=>{$('incoming-call').hidden=true;};
$('friends-nav').onclick=showFriends;
$('music-toggle').onclick=()=>document.body.classList.toggle('show-music');
$('settings').onclick=()=>showDialog('Seu perfil e áudio',container=>{
  const form=el('form');const name=inputField(form,'Nome de exibição',profile.display_name,50),username=inputField(form,'Nome de usuário (3–24 letras, números ou _)',profile.username,24),bio=inputField(form,'Sobre você',profile.bio,160),color=inputField(form,'Cor do perfil',profile.avatar_color,7);color.type='color';
  const label=el('label','check-field');const check=el('input');check.type='checkbox';check.checked=noise;label.append(check,document.createTextNode('Supressão de ruído do microfone'));form.append(label,el('p','muted','O navegador reduz ruído, eco e variações de volume. O resultado depende do dispositivo.'));
  const save=el('button','primary','Salvar alterações');save.type='submit';form.append(save);container.append(form);
  form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{
    await checked(db.from('profiles').update({display_name:name.value.trim(),username:username.value.trim().toLowerCase(),bio:bio.value.trim(),avatar_color:color.value}).eq('id',session.user.id));
    noise=check.checked;localStorage.setItem('orbita-noise',String(noise));
    if(room){for(const pub of room.localParticipant.audioTrackPublications.values())if(pub.track?.source==='microphone')await pub.track.restartTrack(audioCapture());}
    await loadSocial();$('app-dialog').close();toast('Perfil e áudio atualizados.');
  }catch(e){toast(e.code==='23505'?'Esse nome de usuário já está em uso.':errorText(e));}finally{save.disabled=false;}};
});
$('create-channel').onclick=()=>showDialog('Novo canal',container=>{
  const form=el('form'),name=inputField(form,'Nome do canal','',40),type=el('select');
  for(const [value,text]of[['text','Canal de texto'],['voice','Sala de voz e vídeo']]){const opt=el('option','',text);opt.value=value;type.append(opt);}form.append(type);
  const save=el('button','primary','Criar canal');save.type='submit';form.append(save);container.append(form);
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const c=await checked(db.from('channels').insert({name:name.value.trim(),kind:type.value,position:channels.length+1,community_id:activeCommunity}).select().single());channels.push(c);$('app-dialog').close();await selectChannel(c);}catch(e){toast(errorText(e));}finally{save.disabled=false;}};
});
$('dialog-close').onclick=()=>$('app-dialog').close();
$('search-messages').oninput=()=>renderMessages();
$('pins-toggle').onclick=()=>{pinsOnly=!pinsOnly;$('pins-toggle').setAttribute('aria-pressed',String(pinsOnly));renderMessages();};
$('back-to-call').onclick=()=>{if(callChannel)selectChannel(callChannel);};
$('dock-leave').onclick=()=>leaveCall();
$('deafen').onclick=()=>{deafened=!deafened;document.querySelectorAll('[data-remote-audio]').forEach(a=>a.muted=deafened);$('deafen').setAttribute('aria-pressed',String(deafened));};
async function refreshMessages(){
  const version=generation,table=messageTable(),target=selected;
  try{const data=await checked(db.from(table).select(messageFields).eq(scopeKey(target),target.id).order('created_at',{ascending:false}).limit(60));if(version!==generation)return;for(const m of data)messages.set(m.id,m);renderMessages();}catch(e){toast(errorText(e));}
}
async function messageAction(message,action){
  if(action==='delete'){showDialog('Excluir mensagem',container=>{container.append(el('p','','Deseja excluir esta mensagem?'),button('Excluir',async()=>{await checked(db.from(messageTable()).delete().eq('id',message.id));messages.delete(message.id);$('app-dialog').close();renderMessages();},'danger'));});return;}
  if(action==='pin'){await checked(db.from(messageTable()).update({pinned:!message.pinned}).eq('id',message.id));message.pinned=!message.pinned;renderMessages();return;}
  showDialog('Editar mensagem',container=>{const form=el('form'),input=inputField(form,'Mensagem',message.content,4000),save=el('button','primary','Salvar');save.type='submit';form.append(save);container.append(form);form.onsubmit=async e=>{e.preventDefault();try{await checked(db.from(messageTable()).update({content:input.value.trim()}).eq('id',message.id));message.content=input.value.trim();$('app-dialog').close();renderMessages();}catch(error){toast(errorText(error));}};});
}
async function react(message,emoji){
  const mine=(message.reactions||[]).find(r=>r.user_id===session.user.id&&r.emoji===emoji);
  if(mine)await checked(db.from('reactions').delete().eq('id',mine.id));
  else await checked(db.from('reactions').insert({[selected.private?'direct_message_id':'message_id']:message.id,user_id:session.user.id,emoji}));
  await refreshMessages();
}
async function downloadAttachment(a,play=false){
  const response=await apiFetch(`/api/attachments/${a.id}/download`),blob=await response.blob(),url=URL.createObjectURL(new Blob([blob],{type:play?a.mime_type:'application/octet-stream'}));
  if(play)return url;
  const link=el('a');link.href=url;link.download=a.name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function uploadFile(file,target){
  if(!config.driveConfigured)throw Error('O proprietário ainda precisa conectar o Google Drive.');
  if(file.size>config.uploadLimit)throw Error('Escolha um arquivo de até 25 MB.');
  return (await apiFetch(`/api/attachments?target_kind=${target.private?'direct':'channel'}&target_id=${target.id}`,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file})).json();
}
$('attach-file').onclick=()=>{if(!config.driveConfigured)return toast('O Drive está preparado no site, mas falta a autorização Google do proprietário.');$('file-input').click();};
$('file-input').onchange=async()=>{
  const file=$('file-input').files[0],target=selected,version=generation;if(!file)return;
  $('attach-file').disabled=true;try{toast('Enviando arquivo para o Drive…');const attachment=await uploadFile(file,target);
    await checked(db.from(target.private?'direct_messages':'messages').insert({[scopeKey(target)]:target.id,author_id:session.user.id,content:'📎 '+attachment.name,attachment_id:attachment.id}));
    if(version===generation)await refreshMessages();toast('Arquivo enviado.');
  }catch(e){toast(errorText(e));}finally{$('attach-file').disabled=false;$('file-input').value='';}
};
$('drive-info').onclick=()=>showDialog('Arquivos no Google Drive',container=>{
  container.append(el('p','',config.driveConfigured?'O Drive está conectado. Você pode compartilhar arquivos de até 25 MB.':'A integração está preparada. O proprietário precisa autorizar uma pasta do Google Drive para ativar os envios.'),el('p','muted','Os downloads passam pelo site e respeitam as permissões da conversa. Nenhum arquivo privado é compartilhado publicamente.'));
});
function renderMusicStatus(text){$('music-status').textContent=text;}
async function watchMusic(target){
  const version=++musicVersion;musicState=null;audioPlayer.pause();audioPlayer.removeAttribute('src');if(musicUrl){URL.revokeObjectURL(musicUrl);musicUrl=null;}
  if(musicSubscription)await db.removeChannel(musicSubscription);
  renderMusicStatus('Escolha um áudio para ouvir juntos');$('music-play').textContent='▶';
  const reload=async()=>{try{const data=await checked(db.from('music_state').select('*,attachments(id,name,mime_type,size)').eq(scopeKey(target),target.id).maybeSingle());if(version===musicVersion)await applyMusic(data,version);}catch(e){toast(errorText(e));}};
  musicSubscription=db.channel('music-'+target.id+'-'+version).on('postgres_changes',{event:'*',schema:'public',table:'music_state',filter:`${scopeKey(target)}=eq.${target.id}`},reload).subscribe(status=>{if(status==='SUBSCRIBED')reload();});
}
async function applyMusic(state,version){
  if(!state)return;const revision=++musicRevision;const changed=musicState?.attachment_id!==state.attachment_id;musicState=state;
  if(changed){renderMusicStatus('Carregando '+state.attachments.name+'…');const url=await downloadAttachment(state.attachments,true);if(version!==musicVersion||revision!==musicRevision){URL.revokeObjectURL(url);return;}if(musicUrl)URL.revokeObjectURL(musicUrl);musicUrl=url;await new Promise(resolve=>{const timer=setTimeout(resolve,10000);const done=()=>{clearTimeout(timer);resolve();};audioPlayer.addEventListener('loadedmetadata',done,{once:true});audioPlayer.addEventListener('error',done,{once:true});audioPlayer.src=url;});}
  if(version!==musicVersion||revision!==musicRevision)return;
  const position=state.position+(state.playing?Math.max(0,(Date.now()-Date.parse(state.updated_at))/1000):0);
  if(Number.isFinite(audioPlayer.duration)&&Math.abs(audioPlayer.currentTime-position)>1)audioPlayer.currentTime=Math.min(position,audioPlayer.duration);
  renderMusicStatus(state.attachments.name);$('music-play').textContent=state.playing?'❚❚':'▶';
  if(state.playing)try{await audioPlayer.play();}catch{renderMusicStatus('Clique em “Ouvir” para liberar o áudio');}else audioPlayer.pause();
}
async function setMusic(values){
  if(!musicState)throw Error('Primeiro escolha um arquivo de áudio.');
  await checked(db.from('music_state').update({...values,updated_by:session.user.id}).eq('id',musicState.id));
}
$('music-play').onclick=()=>setMusic({playing:!musicState?.playing,position:audioPlayer.currentTime}).catch(e=>toast(errorText(e)));
$('music-listen').onclick=()=>audioPlayer.play().catch(()=>toast('Escolha uma música primeiro.'));
$('music-volume').oninput=e=>{audioPlayer.volume=Number(e.target.value);};
$('music-upload').onclick=()=>{if(!config.driveConfigured)return toast('Conecte o Drive para compartilhar arquivos de música.');$('music-input').click();};
$('music-input').onchange=async()=>{
  const file=$('music-input').files[0],target=selected,version=musicVersion;if(!file||!target)return;
  $('music-upload').disabled=true;
  try{if(!file.type.startsWith('audio/'))throw Error('Escolha um arquivo de áudio compatível com o navegador.');const a=await uploadFile(file,target);
    const existing=await checked(db.from('music_state').select('id').eq(scopeKey(target),target.id).maybeSingle());
    const values={attachment_id:a.id,playing:true,position:0,updated_by:session.user.id};
    if(existing)await checked(db.from('music_state').update(values).eq('id',existing.id));
    else await checked(db.from('music_state').insert({...values,[scopeKey(target)]:target.id}));
    if(version===musicVersion)toast('Música compartilhada com este espaço.');
  }catch(e){toast(errorText(e));}finally{$('music-upload').disabled=false;$('music-input').value='';}
};
audioPlayer.addEventListener('ended',()=>{if(musicState?.updated_by===session?.user.id)setMusic({playing:false,position:0}).catch(e=>toast(errorText(e)));});
$('music-seek').onchange=e=>setMusic({position:Number(e.target.value)}).catch(error=>toast(errorText(error)));
audioPlayer.addEventListener('timeupdate',()=>{if(Number.isFinite(audioPlayer.duration)){$('music-seek').max=String(audioPlayer.duration);if(document.activeElement!==$('music-seek'))$('music-seek').value=String(audioPlayer.currentTime);}});
setInterval(()=>{
  if(!musicState?.playing||audioPlayer.paused||!Number.isFinite(audioPlayer.duration))return;
  const expected=musicState.position+Math.max(0,(Date.now()-Date.parse(musicState.updated_at))/1000);
  if(Math.abs(expected-audioPlayer.currentTime)>2&&expected<audioPlayer.duration)audioPlayer.currentTime=expected;
},5000);

let communities=[],activeCommunity='00000000-0000-4000-8000-000000000001',siteRoles=[],replyTarget=null,friendsFilter='all',extraSubscription;
const isAdmin=()=>siteRoles.some(r=>r.user_id===session?.user.id);
const managesCommunity=()=>isAdmin()||communities.find(c=>c.id===activeCommunity)?.created_by===session?.user.id;
const roleFor=id=>siteRoles.find(r=>r.user_id===id)?.role;
const baseInitSocial=initSocial;
initSocial=async()=>{
  [communities,siteRoles]=await Promise.all([checked(db.from('communities').select('*').order('created_at')),checked(db.from('site_roles').select('*'))]);
  const invitedCommunity=new URLSearchParams(location.search).get('community');
  if(communities.some(c=>c.id===invitedCommunity))activeCommunity=invitedCommunity;
  await baseInitSocial();renderCommunityRail();updateFounders();
  if(extraSubscription)await db.removeChannel(extraSubscription);
  extraSubscription=db.channel('orbita-ui-'+session.user.id)
    .on('postgres_changes',{event:'*',schema:'public',table:'communities'},async()=>{communities=await checked(db.from('communities').select('*').order('created_at'));renderCommunityRail();})
    .on('postgres_changes',{event:'*',schema:'public',table:'site_roles'},async()=>{siteRoles=await checked(db.from('site_roles').select('*'));renderMembers();updateFounders();})
    .on('postgres_changes',{event:'*',schema:'public',table:'poll_votes'},()=>{if(!home&&selected?.kind==='text')refreshMessages();}).subscribe();
  if(new URLSearchParams(location.hash.slice(1)).has('convite'))toast('Entre na conta de Kalil e abra Configurações → Aceitar convite de criador.');
  $('banner-title').textContent=config.driveConfigured?'Drive conectado':'Google Drive';
};
function navigation(direct=false){
  $('sidebar-scroll-content').classList.toggle('hidden',direct);$('dm-scroll-content').classList.toggle('hidden',!direct);
  $('friends-nav').classList.toggle('active',direct);$('server-banner-box').classList.toggle('hidden',direct);
  $('sidebar-server-title').textContent=direct?'Mensagens Diretas':communities.find(c=>c.id===activeCommunity)?.name||'Órbita';
  $('create-channel').hidden=!managesCommunity();document.body.classList.remove('mobile-menu-open');
}
function renderCommunityRail(){
  $('rail-servers-list').replaceChildren();
  for(const c of communities){const b=button(initials(c.name),()=>openCommunity(c),'server-icon'+(c.id===activeCommunity&&!home&&!selected?.private?' active':''));b.title=c.name;$('rail-servers-list').append(b);}
  navigation(home||selected?.private);
}
async function openCommunity(c){
  activeCommunity=c.id;renderCommunityRail();const target=channels.find(ch=>ch.community_id===c.id&&ch.kind==='text')||channels.find(ch=>ch.community_id===c.id);
  if(target)await selectChannel(target);else{showFriends();toast('Esta comunidade ainda não tem canais. Use o menu para criar o primeiro.');navigation(false);}
}
const baseSelect=selectChannel;
selectChannel=async channel=>{
  if(channel.community_id)activeCommunity=channel.community_id;
  replyTarget=null;$('reply-banner').classList.add('hidden');
  await baseSelect(channel);navigation(!!channel.private);renderCommunityRail();
  $('message-input').placeholder=channel.private?'Mensagem para '+channel.name:'Conversar em #'+channel.name;
  $('private-call').hidden=!channel.private||channel.kind==='voice';
};
const baseShowFriends=showFriends;
showFriends=()=>{baseShowFriends();navigation(true);};
$('friends-nav').onclick=showFriends;$('friends-shortcut').onclick=showFriends;
function updateFounders(){
  const names=siteRoles.filter(r=>r.role==='creator').map(r=>person(r.user_id).display_name);
  $('sidebar-boost-pill').textContent='COMUNIDADE';$('creators-credit').textContent='Criadores · '+(names.join(' & ')||'Órbita');
}
const baseRenderMembers=renderMembers;
renderMembers=()=>{baseRenderMembers();for(const row of $('member-list').children){const name=row.querySelector('strong');const p=people.find(p=>p.id===row.dataset.userId);if(p&&roleFor(p.id))name.append(el('span','role-badge',roleFor(p.id)==='creator'?'CRIADOR':'ADMIN'));}updateFounders();};
function safeRichText(text){
  const p=el('p');let last=0;const pattern=/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  for(const match of text.matchAll(pattern)){p.append(document.createTextNode(text.slice(last,match.index)));const code=match[0].startsWith('`');p.append(el(code?'code':'strong','',match[0].slice(code?1:2,code?-1:-2)));last=match.index+match[0].length;}
  p.append(document.createTextNode(text.slice(last)));return p;
}
function renderPoll(message){
  const box=el('div','poll-live');box.append(el('strong','',message.poll.question));
  const votes=message.poll_votes||[],mine=votes.find(v=>v.user_id===session.user.id);
  message.poll.options.forEach((text,index)=>{const count=votes.filter(v=>v.option_index===index).length;const b=button((mine?.option_index===index?'✓ ':'')+text+' · '+count,async()=>{
    const key=selected.private?'direct_message_id':'message_id';b.disabled=true;
    try{await checked(db.from('poll_votes').delete().eq(key,message.id).eq('user_id',session.user.id));if(mine?.option_index!==index)await checked(db.from('poll_votes').insert({[key]:message.id,user_id:session.user.id,option_index:index}));await refreshMessages();}finally{b.disabled=false;}
  },'poll-option');box.append(b);});
  box.append(el('small','muted',votes.length+' votos · uma opção por pessoa'));return box;
}
function replyToMessage(message){replyTarget={id:message.id,scope:selected.id};$('reply-target-name').textContent=message.profiles?.display_name||'Participante';$('reply-banner').classList.remove('hidden');$('message-input').focus();}
$('cancel-reply-btn').onclick=()=>{replyTarget=null;$('reply-banner').classList.add('hidden');};
$('create-poll').onclick=()=>showDialog('Criar enquete',container=>{
  $('attach-popover').classList.add('hidden');const form=el('form'),question=inputField(form,'Pergunta','',200),options=el('textarea');options.rows=5;options.placeholder='Uma opção por linha (2 a 6 opções)';options.maxLength=486;form.append(options);
  const save=el('button','primary','Publicar enquete');save.type='submit';form.append(save);container.append(form);const target=selected;
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const choices=options.value.split('\n').map(s=>s.trim()).filter(Boolean);if(choices.length<2||choices.length>6||choices.some(s=>s.length>80)||!question.value.trim())throw Error('Informe uma pergunta e de 2 a 6 opções de até 80 caracteres.');
    await checked(db.from(target.private?'direct_messages':'messages').insert({[scopeKey(target)]:target.id,author_id:session.user.id,content:question.value.trim(),poll:{question:question.value.trim(),options:choices}}));$('app-dialog').close();await refreshMessages();
  }catch(error){toast(errorText(error));}finally{save.disabled=false;}};
});
$('btn-attach').onclick=()=>$('attach-popover').classList.toggle('hidden');
$('insert-code').onclick=()=>{$('message-input').value+=' `seu código` ';$('message-input').focus();$('attach-popover').classList.add('hidden');};
$('btn-emoji').onclick=()=>$('emoji-popover').classList.toggle('hidden');
for(const emoji of ['😀','😂','❤️','👍','🎉','🔥','👀','🚀','🎧','✨','💜','🙌'])$('emoji-grid').append(button(emoji,()=>{$('message-input').value+=emoji;$('emoji-popover').classList.add('hidden');$('message-input').focus();},'emoji-button'));
$('btn-open-add-friend').onclick=()=>{$('friend-username').focus();};
document.querySelectorAll('[data-ftab]').forEach(t=>t.classList.toggle('active',t.dataset.ftab===friendsFilter));
document.querySelectorAll('[data-ftab]').forEach(tab=>tab.onclick=()=>{friendsFilter=tab.dataset.ftab;document.querySelectorAll('[data-ftab]').forEach(t=>t.classList.toggle('active',t===tab));renderFriends();});
$('server-header-btn').onclick=()=>$('server-dropdown').classList.toggle('hidden');
document.querySelectorAll('.category-header').forEach(header=>header.onclick=e=>{if(!e.target.closest('button'))header.parentElement.classList.toggle('collapsed');});
$('dd-create-channel-btn').onclick=()=>{$('server-dropdown').classList.add('hidden');$('create-channel').click();};
$('dd-settings-btn').onclick=()=>{$('server-dropdown').classList.add('hidden');openManagement();};
function createCommunity(){showDialog('Criar comunidade',container=>{
  const form=el('form'),name=inputField(form,'Nome','',60),description=inputField(form,'Descrição','',240),save=el('button','primary','Criar comunidade');save.type='submit';form.append(save);container.append(form);
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{const c=await checked(db.from('communities').insert({name:name.value.trim(),description:description.value.trim()}).select().single());communities.push(c);const channel=await checked(db.from('channels').insert({name:'geral',kind:'text',community_id:c.id,position:0}).select().single());channels.push(channel);$('app-dialog').close();await openCommunity(c);}catch(error){toast(errorText(error));}finally{save.disabled=false;}};
});}
$('btn-add-server').onclick=createCommunity;
$('btn-explore-servers').onclick=()=>showDialog('Explorar comunidades',container=>{
  container.append(el('p','muted','As comunidades desta versão são abertas às contas cadastradas.'));
  for(const c of communities){const card=el('article','community-card');card.append(el('strong','',c.name),el('p','muted',c.description||'Uma comunidade da Órbita'),button('Abrir',()=>{$('app-dialog').close();return openCommunity(c);},'primary'));container.append(card);}
});
async function copyInvitation(){const url=new URL(location.origin);url.searchParams.set('community',activeCommunity);await navigator.clipboard.writeText(url.href);toast('Link da comunidade copiado.');}
$('dd-invite-btn').onclick=()=>copyInvitation().catch(e=>toast(errorText(e)));
$('dm-quick-find').onclick=()=>showDialog('Busca rápida',container=>{const form=el('form'),input=inputField(form,'Canal ou @ de um amigo','',60),go=el('button','primary','Abrir');go.type='submit';form.append(go);container.append(form);form.onsubmit=async e=>{e.preventDefault();try{const text=input.value.trim().replace(/^[@#]/,'').toLowerCase(),ch=channels.find(c=>c.name.toLowerCase()===text),p=people.find(p=>p.username===text||p.display_name.toLowerCase()===text);if(ch){$('app-dialog').close();await selectChannel(ch);}else if(p){$('app-dialog').close();await startConversation(p);}else toast('Nenhum canal ou usuário encontrado.');}catch(error){toast(errorText(error));}};});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('dm-quick-find').click();}});
$('btn-search-toggle').onclick=()=>$('search-messages').focus();
$('btn-members-toggle').onclick=()=>{document.body.classList.toggle(matchMedia('(max-width:1080px)').matches?'members-open':'members-hidden');$('btn-members-toggle').classList.toggle('active');};
$('mobile-menu-btn').onclick=()=>document.body.classList.toggle('mobile-menu-open');
for(const view of ['friends-view','voice-view']){const target=$(view).querySelector('.chat-title');const menu=button('☰',()=>document.body.classList.toggle('mobile-menu-open'),'mobile-nav-btn');menu.setAttribute('aria-label','Menu de canais');target.prepend(menu);}

$('up-profile-btn').onclick=()=>$('status-popover').classList.toggle('hidden');
document.querySelectorAll('.sp-opt').forEach(opt=>opt.onclick=async()=>{try{const value=opt.dataset.status==='offline'?'invisible':opt.dataset.status||'online';await checked(db.from('profiles').update({presence_status:['online','idle','dnd','invisible'].includes(value)?value:'online'}).eq('id',session.user.id));$('status-popover').classList.add('hidden');await loadSocial();if(presenceChannel){if(value==='invisible')await presenceChannel.untrack();else await publishVoicePresence(true);}updateSelfStatus();}catch(e){toast(errorText(e));}});
$('save-custom-status-btn').onclick=async()=>{try{await checked(db.from('profiles').update({custom_status:$('custom-status-input').value.trim().slice(0,80)}).eq('id',session.user.id));await loadSocial();updateSelfStatus();$('status-popover').classList.add('hidden');}catch(e){toast(errorText(e));}};
function updateSelfStatus(){if(!profile)return;$('self-status-text').textContent=profile.custom_status||({online:'Disponível',idle:'Ausente',dnd:'Não perturbar',invisible:'Invisível'}[profile.presence_status]||'Disponível');$('self-status-dot').style.background=({online:'var(--online)',idle:'var(--idle)',dnd:'var(--dnd)',invisible:'var(--offline)'}[profile.presence_status]);}
const baseLoadSocial=loadSocial;loadSocial=async()=>{await baseLoadSocial();updateSelfStatus();};
const baseSettings=$('settings').onclick;
$('settings').onclick=()=>{
  baseSettings();const container=$('dialog-content'),appearance=el('div');
  const themeLabel=el('label','field','Tema'),theme=el('select');for(const [key,label]of[['orbita','Violeta Órbita'],['blurple','Blurple'],['emerald','Emerald'],['nitro','Pink']]){const option=el('option','',label);option.value=key;theme.append(option);}theme.value=localStorage.getItem('orbita-theme')||'orbita';themeLabel.append(theme);appearance.append(themeLabel);
  const densityLabel=el('label','field','Densidade'),density=el('select');for(const value of ['cozy','compact']){const option=el('option','',value==='cozy'?'Confortável':'Compacta');option.value=value;density.append(option);}density.value=localStorage.getItem('orbita-density')||'cozy';densityLabel.append(density);appearance.append(densityLabel);
  for(const [input,key]of[[theme,'theme'],[density,'density']])input.onchange=()=>{localStorage.setItem('orbita-'+key,input.value);document.body.dataset[key]=input.value;};
  container.append(appearance,button('Aceitar convite de criador',()=>showCreatorInvite()),button('Google Cloud e Google Drive',()=>openCloud()));
  if(isAdmin())container.append(button('Administrar o site',()=>openManagement(),'primary'));
};
function showCreatorInvite(){showDialog('Convite de criador — Kalil',container=>{
  container.append(el('p','muted','Use a conta de Kalil. O convite é privado e só pode ser usado uma vez.'));
  const form=el('form'),input=inputField(form,'Código do convite',new URLSearchParams(location.hash.slice(1)).get('convite')||'',256),save=el('button','primary','Assumir administração');input.type='password';save.type='submit';form.append(save);container.append(form);
  form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{await checked(db.rpc('claim_creator_invite',{invitation:input.value.trim()}));siteRoles=await checked(db.from('site_roles').select('*'));history.replaceState(null,'',location.pathname+location.search);$('app-dialog').close();renderMembers();toast('Conta vinculada como criador e administrador.');}catch(error){toast(errorText(error));}finally{save.disabled=false;}};
});}
function openManagement(){showDialog(isAdmin()?'Administração do site':'Configurações da comunidade',container=>{
  const c=communities.find(c=>c.id===activeCommunity);container.append(el('p','muted',isAdmin()?'Você pode administrar todas as comunidades e moderar mensagens públicas. As conversas privadas mantêm suas permissões.':'A administração desta comunidade pertence ao criador dela.'));
  if(!managesCommunity()){container.append(el('p','','Você não tem permissão para alterar esta comunidade.'));return;}
  const form=el('form'),name=inputField(form,'Nome',c?.name,60),description=inputField(form,'Descrição',c?.description,240),save=el('button','primary','Salvar comunidade');save.type='submit';form.append(save);container.append(form);
  form.onsubmit=async e=>{e.preventDefault();try{await checked(db.from('communities').update({name:name.value.trim(),description:description.value.trim()}).eq('id',activeCommunity));c.name=name.value.trim();c.description=description.value.trim();renderCommunityRail();toast('Comunidade atualizada.');}catch(error){toast(errorText(error));}};
  const actions=el('div','admin-menu');actions.append(button('Criar canal',()=>{$('app-dialog').close();$('create-channel').click();}),button('Google Cloud / Drive',()=>openCloud()));container.append(actions);
  for(const channel of channels.filter(ch=>ch.community_id===activeCommunity)){const row=el('div','community-card');row.append(el('strong','',channel.name),button('Editar',()=>editChannel(channel)));container.append(row);}
});}
function editChannel(channel){showDialog('Editar canal',container=>{const form=el('form'),name=inputField(form,'Nome',channel.name,40),description=inputField(form,'Descrição',channel.description,240),save=el('button','primary','Salvar');save.type='submit';form.append(save);container.append(form);form.onsubmit=async e=>{e.preventDefault();try{await checked(db.from('channels').update({name:name.value.trim(),description:description.value.trim()}).eq('id',channel.id));channel.name=name.value.trim();channel.description=description.value.trim();renderChannels();if(selected?.id===channel.id)await selectChannel(channel);$('app-dialog').close();}catch(error){toast(errorText(error));}};
container.append(button('Excluir canal e seu histórico',()=>showDialog('Excluir canal',box=>{box.append(el('p','','A exclusão remove permanentemente o histórico deste canal. Confirme somente se desejar apagar esses dados.'),button('Excluir permanentemente',async()=>{await checked(db.from('channels').delete().eq('id',channel.id));channels=channels.filter(ch=>ch.id!==channel.id);$('app-dialog').close();renderChannels();if(selected?.id===channel.id)showFriends();},'danger'));}),'danger'));});}
function openCloud(){showDialog('Google Cloud e arquivos',container=>{
  container.append(el('p','',config.driveConfigured?'Google Drive conectado. Arquivos de até 25 MB estão disponíveis.':'A conexão Google aguarda as credenciais OAuth do proprietário. Nenhum serviço pago foi ativado.'),el('p','muted','O Supabase mantém contas, mensagens e permissões. O Drive armazena arquivos e cópias JSON do banco da comunidade, sem incluir conversas privadas de outras pessoas.'));
  container.append(el('p','muted','Monitoramento Google: '+(config.firebaseConfig?'configurado; ative nas preferências de diagnóstico.':'aguardando configuração do projeto Firebase.')));
  if(isAdmin())container.append(button('Salvar cópia do banco no Drive',async()=>{const result=await(await apiFetch('/api/admin/drive-backup',{method:'POST'})).json();toast(result.message);},'primary'));
  const label=el('label','check-field'),check=el('input');check.type='checkbox';check.checked=localStorage.getItem('orbita-diagnostics')==='true';label.append(check,document.createTextNode('Permitir diagnóstico de desempenho pelo Firebase'));container.append(label);check.onchange=()=>{localStorage.setItem('orbita-diagnostics',String(check.checked));if(check.checked)startGooglePerformance();toast('Preferência salva. Recarregue a página para encerrar uma sessão de diagnóstico ativa.');};
});}
$('dd-boost-btn').onclick=openCloud;$('banner-action-btn').onclick=openCloud;$('drive-info').onclick=openCloud;
$('up-mic-btn').onclick=()=>$('mic').click();$('up-deafen-btn').onclick=()=>$('deafen').click();$('vb-mic').onclick=()=>$('mic').click();$('vb-video').onclick=()=>$('camera').click();$('dock-name').onclick=()=>{if(callChannel)selectChannel(callChannel);};
$('back-to-call').onclick=()=>{if(selected?.private){const c=conversations.find(c=>c.id===selected.id);if(c)openConversation(c);}else{const c=channels.find(c=>c.community_id===activeCommunity&&c.kind==='text');if(c)selectChannel(c);}};
$('connection-info').onclick=()=>showDialog('Conexão da chamada',container=>{container.append(el('p','',room?'Estado: '+room.state:'Você ainda não está em uma chamada.'));if(room){container.append(el('p','','Qualidade local: '+room.localParticipant.connectionQuality));for(const p of room.remoteParticipants.values())container.append(el('p','',(p.name||'Participante')+' · '+p.connectionQuality));}container.append(el('p','muted','Vídeo e áudio se adaptam à rede. O áudio da tela depende do navegador e da opção escolhida na janela de compartilhamento.'));});
let lastReaction=0;
$('vc-react-call').onclick=async()=>{if(!room||Date.now()-lastReaction<2000)return;lastReaction=Date.now();try{await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({type:'reaction',emoji:'🎉'})),{reliable:true,topic:'orbita-reaction'});toast('Você · 🎉');}catch(e){toast(errorText(e));}};
function receiveCallData(payload,participant,_kind,topic){if(topic!=='orbita-reaction'||payload.length>200)return;try{const data=JSON.parse(new TextDecoder().decode(payload));if(data.type==='reaction'&&['🎉','❤️','👍','😂','🔥','👀','🚀'].includes(data.emoji)){
  toast((participant?.name||'Participante')+' · '+data.emoji);
  showReactionOverlay(participant.identity || participant.sid, data.emoji);
}}catch{}}
const screenLabel=el('label','screen-option'),screenCheck=el('input');screenCheck.type='checkbox';screenCheck.id='share-screen-audio';screenCheck.checked=localStorage.getItem('orbita-screen-audio')!=='false';screenLabel.append(screenCheck,document.createTextNode('Incluir áudio da tela (autorize também na janela do navegador)'));$('active-controls').before(screenLabel);
function updateScreenAudio(){SCREEN_CAPTURE.audio=screenCheck.checked;SCREEN_CAPTURE.systemAudio=screenCheck.checked?'include':'exclude';SCREEN_CAPTURE.surfaceSwitching='include';localStorage.setItem('orbita-screen-audio',String(screenCheck.checked));}
screenCheck.onchange=updateScreenAudio;updateScreenAudio();
async function startGooglePerformance(){
  if(!config?.firebaseConfig||localStorage.getItem('orbita-diagnostics')!=='true')return;
  try{const{initializeApp,getApps}=await import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js');const{getPerformance,isSupported}=await import('https://www.gstatic.com/firebasejs/12.4.0/firebase-performance.js');if(await isSupported())getPerformance(getApps()[0]||initializeApp(config.firebaseConfig));}catch{toast('O diagnóstico Google está indisponível neste navegador.');}
}
$('btn-notif-toggle').onclick=async()=>{if(!('Notification'in window))return toast('Este navegador não oferece notificações.');const permission=await Notification.requestPermission();toast(permission==='granted'?'Notificações ativadas neste navegador.':'Notificações não autorizadas.');};
document.body.dataset.theme=localStorage.getItem('orbita-theme')||'orbita';document.body.dataset.density=localStorage.getItem('orbita-density')||'cozy';
window.addEventListener('pagehide',()=>{if(extraSubscription)db?.removeChannel(extraSubscription);});

async function publishVoicePresence(force=false){
  if(!presenceChannel||!session||!profile)return;
  if(profile.presence_status==='invisible'){if(force)await presenceChannel.untrack();return;}
  const value={status:profile.presence_status||'online',channel_id:room&&!callChannel?.private?callChannel?.id:null,microphone:!!room?.localParticipant.isMicrophoneEnabled,screen:!!room?.localParticipant.isScreenShareEnabled};
  const signature=JSON.stringify(value);if(!force&&signature===lastPresenceSignature)return;lastPresenceSignature=signature;await presenceChannel.track(value);
}
boot();
