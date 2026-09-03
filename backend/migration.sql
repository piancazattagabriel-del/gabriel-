-- Execute este script no SQL Editor do Supabase.
alter table public.pesquisas_politicas
    add column if not exists visualizacoes bigint not null default 0;

update public.pesquisas_politicas
set visualizacoes = 0
where visualizacoes is null;

create or replace function public.incrementar_visualizacoes(noticia_id bigint)
returns bigint
language sql
security definer
set search_path = public
as $$
    update public.pesquisas_politicas as noticia
    set visualizacoes = coalesce(noticia.visualizacoes, 0) + 1
    where noticia.id = incrementar_visualizacoes.noticia_id
    returning noticia.visualizacoes;
$$;