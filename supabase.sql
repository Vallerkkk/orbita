-- Execute no SQL Editor de um projeto Supabase novo.
-- Esta primeira versão tem UMA comunidade compartilhada por todas as contas cadastradas.
begin;
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 50)
);
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null check (kind in ('text','voice')),
  position integer not null default 0
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists messages_channel_time on public.messages(channel_id, created_at desc);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), 'Participante'),50));
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();
insert into public.profiles(id, display_name)
select id, left(coalesce(nullif(trim(raw_user_meta_data->>'display_name'), ''),'Participante'),50)
from auth.users on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists channels_read on public.channels;
create policy channels_read on public.channels for select to authenticated using (true);
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated using (true);
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check (
  author_id = (select auth.uid()) and exists (
    select 1 from public.channels c where c.id = channel_id and c.kind = 'text'
  )
);
-- Não há permissões de alteração de canais, edição de perfis ou exclusão de mensagens no MVP.
revoke all on public.profiles, public.channels, public.messages from anon, authenticated;
grant select on public.profiles, public.channels, public.messages to authenticated;
grant insert (channel_id, author_id, content) on public.messages to authenticated;

insert into public.channels(name,kind,position) values
 ('geral','text',0),('projetos','text',1),('aleatório','text',2),
 ('Sala de estar','voice',3),('Foco & trabalho','voice',4)
on conflict do nothing;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
    and schemaname='public' and tablename='messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
-- Evolução aditiva: preserva contas, canais e histórico existentes.
alter table public.profiles add column if not exists username text not null default ('orbiter_' || substr(replace(gen_random_uuid()::text,'-',''),1,12));
alter table public.profiles add column if not exists bio text not null default '' check (char_length(bio)<=160);
alter table public.profiles add column if not exists avatar_color text not null default '#8b80ff' check (avatar_color ~ '^#[0-9a-fA-F]{6}$');
create unique index if not exists profiles_username on public.profiles(lower(username));
alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format check(username ~ '^[a-z0-9_]{3,24}$');
grant update(display_name,username,bio,avatar_color) on public.profiles to authenticated;
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated using(id=(select auth.uid())) with check(id=(select auth.uid()));

alter table public.channels add column if not exists created_by uuid references public.profiles(id) default auth.uid();
grant insert(name,kind,position) on public.channels to authenticated;
drop policy if exists channels_create on public.channels;
create policy channels_create on public.channels for insert to authenticated with check(created_by=(select auth.uid()) and char_length(name) between 1 and 40);

create table if not exists public.friendships(
 id uuid primary key default gen_random_uuid(),
 requester_id uuid not null references public.profiles(id) on delete cascade,
 recipient_id uuid not null references public.profiles(id) on delete cascade,
 status text not null default 'pending' check(status in ('pending','accepted')),
 created_at timestamptz not null default now(), check(requester_id<>recipient_id)
);
create unique index if not exists friendships_pair on public.friendships(least(requester_id,recipient_id),greatest(requester_id,recipient_id));
create index if not exists friendships_recipient on public.friendships(recipient_id,status);
create index if not exists friendships_requester on public.friendships(requester_id,status);
alter table public.friendships enable row level security;
revoke all on public.friendships from anon,authenticated;
grant select,delete on public.friendships to authenticated;
grant insert(requester_id,recipient_id),update(status) on public.friendships to authenticated;
drop policy if exists friendship_read on public.friendships;
create policy friendship_read on public.friendships for select to authenticated using((select auth.uid()) in (requester_id,recipient_id));
drop policy if exists friendship_request on public.friendships;
create policy friendship_request on public.friendships for insert to authenticated with check(requester_id=(select auth.uid()) and status='pending');
drop policy if exists friendship_accept on public.friendships;
create policy friendship_accept on public.friendships for update to authenticated using(recipient_id=(select auth.uid()) and status='pending') with check(recipient_id=(select auth.uid()) and status='accepted');
drop policy if exists friendship_remove on public.friendships;
create policy friendship_remove on public.friendships for delete to authenticated using((select auth.uid()) in (requester_id,recipient_id));

create table if not exists public.conversations(
 id uuid primary key default gen_random_uuid(),
 user_a uuid not null references public.profiles(id) on delete cascade,
 user_b uuid not null references public.profiles(id) on delete cascade,
 created_at timestamptz not null default now(),check(user_a<user_b),unique(user_a,user_b)
);
create index if not exists conversations_b on public.conversations(user_b);
alter table public.conversations enable row level security;
revoke all on public.conversations from anon,authenticated;
grant select on public.conversations to authenticated;
grant insert(user_a,user_b) on public.conversations to authenticated;
drop policy if exists conversation_members on public.conversations;
create policy conversation_members on public.conversations for select to authenticated using((select auth.uid()) in (user_a,user_b));
drop policy if exists conversation_create on public.conversations;
create policy conversation_create on public.conversations for insert to authenticated with check(
 (select auth.uid()) in(user_a,user_b) and exists(select 1 from public.friendships f where f.status='accepted' and least(f.requester_id,f.recipient_id)=user_a and greatest(f.requester_id,f.recipient_id)=user_b)
);

create table if not exists public.attachments(
 id uuid primary key default gen_random_uuid(),owner_id uuid not null references public.profiles(id),
 channel_id uuid references public.channels(id) on delete cascade,
 conversation_id uuid references public.conversations(id) on delete cascade,
 file_id text not null unique,name text not null check(char_length(name) between 1 and 180),
 mime_type text not null,size bigint not null check(size between 1 and 26214400),
 storage_proof text not null,created_at timestamptz not null default now(),
 check(num_nonnulls(channel_id,conversation_id)=1)
);
create index if not exists attachments_channel on public.attachments(channel_id,created_at);
create index if not exists attachments_conversation on public.attachments(conversation_id,created_at);
alter table public.attachments enable row level security;
revoke all on public.attachments from anon,authenticated;
grant select on public.attachments to authenticated;
grant insert(owner_id,channel_id,conversation_id,file_id,name,mime_type,size,storage_proof) on public.attachments to authenticated;
drop policy if exists attachment_scope_read on public.attachments;
create policy attachment_scope_read on public.attachments for select to authenticated using(
 channel_id is not null or exists(select 1 from public.conversations c where c.id=conversation_id)
);
drop policy if exists attachment_scope_insert on public.attachments;
create policy attachment_scope_insert on public.attachments for insert to authenticated with check(owner_id=(select auth.uid()) and (
 exists(select 1 from public.channels c where c.id=channel_id) or exists(select 1 from public.conversations c where c.id=conversation_id)
));
-- storage_proof é validada pelo servidor antes de acessar o Drive: um cliente não pode forjar um file_id.

alter table public.messages add column if not exists attachment_id uuid references public.attachments(id);
alter table public.messages add column if not exists pinned boolean not null default false;
grant insert(attachment_id),update(content,pinned),delete on public.messages to authenticated;
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages for insert to authenticated with check(author_id=(select auth.uid()) and exists(select 1 from public.channels c where c.id=channel_id and c.kind='text') and (attachment_id is null or exists(select 1 from public.attachments a where a.id=attachment_id and a.owner_id=author_id and a.channel_id=messages.channel_id)));
drop policy if exists messages_own_edit on public.messages;
create policy messages_own_edit on public.messages for update to authenticated using(author_id=(select auth.uid())) with check(author_id=(select auth.uid()));
drop policy if exists messages_own_delete on public.messages;
create policy messages_own_delete on public.messages for delete to authenticated using(author_id=(select auth.uid()));

create table if not exists public.direct_messages(
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.conversations(id) on delete cascade,
 author_id uuid not null references public.profiles(id),content text not null check(char_length(trim(content)) between 1 and 4000),
 attachment_id uuid references public.attachments(id),pinned boolean not null default false,created_at timestamptz not null default now()
);
create index if not exists direct_messages_history on public.direct_messages(conversation_id,created_at desc,id desc);
alter table public.direct_messages enable row level security;
revoke all on public.direct_messages from anon,authenticated;
grant select,delete on public.direct_messages to authenticated;
grant insert(conversation_id,author_id,content,attachment_id),update(content,pinned) on public.direct_messages to authenticated;
drop policy if exists direct_members_read on public.direct_messages;
create policy direct_members_read on public.direct_messages for select to authenticated using(exists(select 1 from public.conversations c where c.id=conversation_id));
drop policy if exists direct_members_insert on public.direct_messages;
create policy direct_members_insert on public.direct_messages for insert to authenticated with check(author_id=(select auth.uid()) and exists(select 1 from public.conversations c join public.friendships f on least(f.requester_id,f.recipient_id)=c.user_a and greatest(f.requester_id,f.recipient_id)=c.user_b where c.id=conversation_id and f.status='accepted') and (attachment_id is null or exists(select 1 from public.attachments a where a.id=attachment_id and a.owner_id=author_id and a.conversation_id=direct_messages.conversation_id)));
drop policy if exists direct_own_edit on public.direct_messages;
create policy direct_own_edit on public.direct_messages for update to authenticated using(author_id=(select auth.uid())) with check(author_id=(select auth.uid()));
drop policy if exists direct_own_delete on public.direct_messages;
create policy direct_own_delete on public.direct_messages for delete to authenticated using(author_id=(select auth.uid()));

create table if not exists public.reactions(
 id uuid primary key default gen_random_uuid(),message_id uuid references public.messages(id) on delete cascade,
 direct_message_id uuid references public.direct_messages(id) on delete cascade,user_id uuid not null references public.profiles(id),
 emoji text not null check(emoji in('👍','❤️','😂','🎉','🔥','👀')),check(num_nonnulls(message_id,direct_message_id)=1)
);
create unique index if not exists reactions_message_unique on public.reactions(message_id,user_id,emoji) where message_id is not null;
create unique index if not exists reactions_direct_unique on public.reactions(direct_message_id,user_id,emoji) where direct_message_id is not null;
alter table public.reactions enable row level security;
revoke all on public.reactions from anon,authenticated;
grant select,delete on public.reactions to authenticated;
grant insert(message_id,direct_message_id,user_id,emoji) on public.reactions to authenticated;
drop policy if exists reaction_read on public.reactions;
create policy reaction_read on public.reactions for select to authenticated using(exists(select 1 from public.messages m where m.id=message_id) or exists(select 1 from public.direct_messages m where m.id=direct_message_id));
drop policy if exists reaction_insert on public.reactions;
create policy reaction_insert on public.reactions for insert to authenticated with check(user_id=(select auth.uid()) and (exists(select 1 from public.messages m where m.id=message_id) or exists(select 1 from public.direct_messages m where m.id=direct_message_id)));
drop policy if exists reaction_delete on public.reactions;
create policy reaction_delete on public.reactions for delete to authenticated using(user_id=(select auth.uid()));

create table if not exists public.call_events(
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.conversations(id) on delete cascade,
 caller_id uuid not null references public.profiles(id),created_at timestamptz not null default now()
);
create index if not exists call_events_conversation on public.call_events(conversation_id,created_at desc);
alter table public.call_events enable row level security;
revoke all on public.call_events from anon,authenticated;
grant select on public.call_events to authenticated;
grant insert(conversation_id,caller_id) on public.call_events to authenticated;
drop policy if exists call_event_read on public.call_events;
create policy call_event_read on public.call_events for select to authenticated using(exists(select 1 from public.conversations c where c.id=conversation_id));
drop policy if exists call_event_insert on public.call_events;
create policy call_event_insert on public.call_events for insert to authenticated with check(caller_id=(select auth.uid()) and exists(select 1 from public.conversations c join public.friendships f on least(f.requester_id,f.recipient_id)=c.user_a and greatest(f.requester_id,f.recipient_id)=c.user_b where c.id=conversation_id and f.status='accepted'));

create table if not exists public.music_state(
 id uuid primary key default gen_random_uuid(),channel_id uuid references public.channels(id) on delete cascade,
 conversation_id uuid references public.conversations(id) on delete cascade,attachment_id uuid not null references public.attachments(id),
 playing boolean not null default false,position double precision not null default 0 check(position between 0 and 86400),
 updated_by uuid not null references public.profiles(id),updated_at timestamptz not null default now(),check(num_nonnulls(channel_id,conversation_id)=1)
);
create unique index if not exists music_channel_unique on public.music_state(channel_id);
create unique index if not exists music_direct_unique on public.music_state(conversation_id);
alter table public.music_state enable row level security;
revoke all on public.music_state from anon,authenticated;
grant select on public.music_state to authenticated;
grant insert(channel_id,conversation_id,attachment_id,playing,position,updated_by),update(attachment_id,playing,position,updated_by) on public.music_state to authenticated;
drop policy if exists music_read on public.music_state;
create policy music_read on public.music_state for select to authenticated using(channel_id is not null or exists(select 1 from public.conversations c where c.id=conversation_id));
drop policy if exists music_insert on public.music_state;
create policy music_insert on public.music_state for insert to authenticated with check(updated_by=(select auth.uid()) and exists(select 1 from public.attachments a where a.id=attachment_id and a.mime_type like 'audio/%' and (a.channel_id=music_state.channel_id or a.conversation_id=music_state.conversation_id)));
drop policy if exists music_update on public.music_state;
create policy music_update on public.music_state for update to authenticated using(channel_id is not null or exists(select 1 from public.conversations c where c.id=conversation_id)) with check(updated_by=(select auth.uid()) and exists(select 1 from public.attachments a where a.id=attachment_id and a.mime_type like 'audio/%' and (a.channel_id=music_state.channel_id or a.conversation_id=music_state.conversation_id)));
create schema if not exists orbita_private;
create or replace function orbita_private.touch_music() returns trigger language plpgsql set search_path='' as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists music_timestamp on public.music_state;
create trigger music_timestamp before update on public.music_state for each row execute function orbita_private.touch_music();

drop policy if exists orbita_presence_read on realtime.messages;
create policy orbita_presence_read on realtime.messages for select to authenticated using((select realtime.topic())='community:main');
drop policy if exists orbita_presence_write on realtime.messages;
create policy orbita_presence_write on realtime.messages for insert to authenticated with check((select realtime.topic())='community:main');

do $$ declare tablename_to_add text; begin
 foreach tablename_to_add in array array['friendships','conversations','direct_messages','reactions','call_events','music_state','attachments','profiles','channels'] loop
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=tablename_to_add) then
   execute format('alter publication supabase_realtime add table public.%I',tablename_to_add);
  end if;
 end loop;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
commit;

begin;
create table if not exists public.site_roles(user_id uuid primary key references public.profiles(id) on delete cascade,role text not null check(role in('creator','admin')),created_at timestamptz not null default now());
alter table public.site_roles enable row level security;
revoke all on public.site_roles from public,anon,authenticated;
grant select on public.site_roles to authenticated;
drop policy if exists site_roles_read on public.site_roles;
create policy site_roles_read on public.site_roles for select to authenticated using(true);
create or replace function public.is_site_admin() returns boolean language sql stable security invoker set search_path='' as $$select exists(select 1 from public.site_roles where user_id=(select auth.uid()) and role in('creator','admin'))$$;
revoke all on function public.is_site_admin() from public,anon;
grant execute on function public.is_site_admin() to authenticated;

create table if not exists orbita_private.creator_invites(token_hash text primary key,target_name text not null,expires_at timestamptz not null,claimed_by uuid references public.profiles(id),claimed_at timestamptz);
alter table orbita_private.creator_invites enable row level security;
revoke all on orbita_private.creator_invites from public,anon,authenticated;
create or replace function orbita_private.claim_creator(invitation text) returns boolean language plpgsql security definer set search_path='' as $$
declare uid uuid:=(select auth.uid()); invite orbita_private.creator_invites; begin
 if uid is null or length(invitation)>256 or length(invitation)<32 then raise exception 'Convite inválido'; end if;
 select * into invite from orbita_private.creator_invites where token_hash=encode(sha256(convert_to(invitation,'UTF8')),'hex') for update;
 if not found or invite.expires_at<now() then raise exception 'Convite inválido ou expirado';end if;
 if invite.claimed_by=uid then return true;end if;
 if invite.claimed_by is not null then raise exception 'Convite já utilizado';end if;
 if not exists(select 1 from public.profiles p where p.id=uid and lower(trim(p.display_name))=lower(invite.target_name))then raise exception 'Entre na conta de % para aceitar este convite',invite.target_name;end if;
 insert into public.site_roles(user_id,role)values(uid,'creator')on conflict(user_id)do update set role='creator';
 update orbita_private.creator_invites set claimed_by=uid,claimed_at=now() where token_hash=invite.token_hash;
 return true;
end $$;
revoke all on function orbita_private.claim_creator(text) from public,anon;
grant usage on schema orbita_private to authenticated;
grant execute on function orbita_private.claim_creator(text) to authenticated;
create or replace function public.claim_creator_invite(invitation text) returns boolean language sql security invoker set search_path='' as $$select orbita_private.claim_creator(invitation)$$;
revoke all on function public.claim_creator_invite(text) from public,anon;
grant execute on function public.claim_creator_invite(text) to authenticated;

create table if not exists public.communities(id uuid primary key default gen_random_uuid(),name text not null check(char_length(trim(name)) between 2 and 60),description text not null default '' check(char_length(description)<=240),created_by uuid default auth.uid() references public.profiles(id),is_default boolean not null default false,created_at timestamptz not null default now());
alter table public.communities enable row level security;
revoke all on public.communities from public,anon,authenticated;
grant select on public.communities to authenticated;
grant insert(name,description),update(name,description),delete on public.communities to authenticated;
create unique index if not exists communities_default on public.communities(is_default)where is_default;
drop policy if exists communities_read on public.communities;
create policy communities_read on public.communities for select to authenticated using(true);
drop policy if exists communities_create on public.communities;
create policy communities_create on public.communities for insert to authenticated with check(created_by=(select auth.uid()) and not is_default);
drop policy if exists communities_manage on public.communities;
create policy communities_manage on public.communities for update to authenticated using(created_by=(select auth.uid()) or (select public.is_site_admin()))with check(created_by=(select auth.uid()) or (select public.is_site_admin()));
drop policy if exists communities_delete on public.communities;
create policy communities_delete on public.communities for delete to authenticated using(not is_default and(created_by=(select auth.uid()) or (select public.is_site_admin())));
insert into public.communities(id,name,is_default)values('00000000-0000-4000-8000-000000000001','Órbita',true)on conflict(id)do nothing;
alter table public.channels add column if not exists community_id uuid not null default '00000000-0000-4000-8000-000000000001' references public.communities(id)on delete cascade;
alter table public.channels add column if not exists description text not null default '' check(char_length(description)<=240);
create index if not exists channels_community on public.channels(community_id,position);
grant insert(community_id,description),update(name,description),delete on public.channels to authenticated;
drop policy if exists channels_create on public.channels;
create policy channels_create on public.channels for insert to authenticated with check(created_by=(select auth.uid()) and (select public.is_site_admin()) or(created_by=(select auth.uid()) and exists(select 1 from public.communities c where c.id=community_id and c.created_by=(select auth.uid()))));
drop policy if exists channels_manage on public.channels;
create policy channels_manage on public.channels for update to authenticated using((select public.is_site_admin())or exists(select 1 from public.communities c where c.id=community_id and c.created_by=(select auth.uid()))) with check((select public.is_site_admin())or exists(select 1 from public.communities c where c.id=community_id and c.created_by=(select auth.uid())));
drop policy if exists channels_delete on public.channels;
create policy channels_delete on public.channels for delete to authenticated using((select public.is_site_admin())or exists(select 1 from public.communities c where c.id=community_id and c.created_by=(select auth.uid())));
-- Equal names in different communities are allowed.
alter table public.channels drop constraint if exists channels_name_key;
create unique index if not exists channels_community_name on public.channels(community_id,lower(name));

alter table public.profiles add column if not exists presence_status text not null default 'online' check(presence_status in('online','idle','dnd','invisible'));
alter table public.profiles add column if not exists custom_status text not null default '' check(char_length(custom_status)<=80);
grant update(presence_status,custom_status)on public.profiles to authenticated;

create or replace function orbita_private.valid_poll(value jsonb)returns boolean language plpgsql immutable set search_path='' as $$
declare item jsonb;begin
 if value is null then return true;end if;
 if jsonb_typeof(value) is distinct from 'object' or jsonb_typeof(value->'question') is distinct from 'string' or char_length(coalesce(value->>'question',''))not between 1 and 200 or jsonb_typeof(value->'options') is distinct from 'array' then return false;end if;
 if jsonb_array_length(value->'options')not between 2 and 6 then return false;end if;
 for item in select jsonb_array_elements(value->'options')loop if jsonb_typeof(item)<>'string' or char_length(item#>>'{}')not between 1 and 80 then return false;end if;end loop;
 return true;
end $$;
alter table public.messages add column if not exists reply_to uuid references public.messages(id)on delete set null;
alter table public.direct_messages add column if not exists reply_to uuid references public.direct_messages(id)on delete set null;
alter table public.messages add column if not exists poll jsonb check(orbita_private.valid_poll(poll));
alter table public.direct_messages add column if not exists poll jsonb check(orbita_private.valid_poll(poll));
grant insert(reply_to,poll)on public.messages,public.direct_messages to authenticated;
create or replace function orbita_private.check_reply()returns trigger language plpgsql security invoker set search_path='' as $$
declare target uuid;begin
 if new.reply_to is null then return new;end if;
 if tg_table_name='messages'then select channel_id into target from public.messages where id=new.reply_to;if target is distinct from new.channel_id then raise exception 'Resposta fora do canal';end if;
 else select conversation_id into target from public.direct_messages where id=new.reply_to;if target is distinct from new.conversation_id then raise exception 'Resposta fora da conversa';end if;end if;
 return new;end $$;
drop trigger if exists messages_reply_scope on public.messages;
create trigger messages_reply_scope before insert on public.messages for each row execute function orbita_private.check_reply();
drop trigger if exists direct_reply_scope on public.direct_messages;
create trigger direct_reply_scope before insert on public.direct_messages for each row execute function orbita_private.check_reply();
drop policy if exists messages_admin_update on public.messages;
create policy messages_admin_update on public.messages for update to authenticated using((select public.is_site_admin()))with check((select public.is_site_admin()));
drop policy if exists messages_admin_delete on public.messages;
create policy messages_admin_delete on public.messages for delete to authenticated using((select public.is_site_admin()));

create table if not exists public.poll_votes(id uuid primary key default gen_random_uuid(),message_id uuid references public.messages(id)on delete cascade,direct_message_id uuid references public.direct_messages(id)on delete cascade,user_id uuid not null references public.profiles(id)on delete cascade,option_index integer not null check(option_index between 0 and 5),check(num_nonnulls(message_id,direct_message_id)=1));
create unique index if not exists votes_message_user on public.poll_votes(message_id,user_id)where message_id is not null;
create unique index if not exists votes_direct_user on public.poll_votes(direct_message_id,user_id)where direct_message_id is not null;
alter table public.poll_votes enable row level security;
revoke all on public.poll_votes from public,anon,authenticated;
grant select,delete on public.poll_votes to authenticated;
grant insert(message_id,direct_message_id,user_id,option_index)on public.poll_votes to authenticated;
drop policy if exists votes_read on public.poll_votes;
create policy votes_read on public.poll_votes for select to authenticated using(exists(select 1 from public.messages m where m.id=message_id)or exists(select 1 from public.direct_messages m where m.id=direct_message_id));
drop policy if exists votes_insert on public.poll_votes;
create policy votes_insert on public.poll_votes for insert to authenticated with check(user_id=(select auth.uid())and(exists(select 1 from public.messages m where m.id=message_id and m.poll is not null and option_index<jsonb_array_length(m.poll->'options'))or exists(select 1 from public.direct_messages m where m.id=direct_message_id and m.poll is not null and option_index<jsonb_array_length(m.poll->'options'))));
drop policy if exists votes_delete on public.poll_votes;
create policy votes_delete on public.poll_votes for delete to authenticated using(user_id=(select auth.uid()));

do $$ declare tab text;begin foreach tab in array array['communities','poll_votes','site_roles']loop
if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'and schemaname='public'and tablename=tab)then execute format('alter publication supabase_realtime add table public.%I',tab);end if;end loop;end $$;
commit;

drop policy if exists creator_invites_deny_direct_access on orbita_private.creator_invites;
create policy creator_invites_deny_direct_access on orbita_private.creator_invites for all to anon,authenticated using(false)with check(false);
