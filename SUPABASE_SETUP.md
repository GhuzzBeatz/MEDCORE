# MedCore + Supabase (modelo seguro com tabelas separadas)

Guia simples, passo a passo.

## O que mudou

Antes:
- Tudo ficava em uma tabela tecnica unica (`workspace_rows`).

Agora (mais seguro e escalavel):
- Cada categoria tem sua propria tabela:
  - `workspace_config_rows`
  - `workspace_usuarios_rows`
  - `workspace_medicos_rows`
  - `workspace_pacientes_rows`
  - `workspace_agenda_rows`
  - `workspace_prontuarios_rows`
  - `workspace_asos_rows`
  - `workspace_financeiro_rows`
  - `workspace_estoque_rows`
  - `workspace_medicamentos_rows`
  - `workspace_exames_banco_rows`
  - `workspace_solicitacoes_exames_rows`
  - `workspace_receituarios_salvos_rows`
  - `workspace_locais_rows`

Isso reduz conflito, facilita auditoria e melhora consistencia de sincronizacao.

## Parte 1 - Preparar Supabase

1. Abra o projeto no Supabase.
2. Entre em **SQL Editor**.
3. Rode inteiro:
- `supabase/setup.sql`
4. Se voce ja tem dados antigos (em `workspace_snapshots` e/ou `workspace_rows`), rode depois:
- `supabase/migrate_legacy_to_rows.sql`

## Parte 2 - O que fazer com as tabelas antigas

Nao exclua agora.

Mantenha por seguranca estas tabelas antigas por alguns dias:
- `workspace_snapshots`
- `workspace_rows`

Fluxo recomendado:
1. Rodar setup + migracao.
2. Testar em 2 PCs (incluir, editar, excluir, confirmar sincronizacao).
3. Depois de validar, opcional:
- Renomear antigas para backup (`workspace_snapshots_backup`, `workspace_rows_backup`)  
ou
- Exportar CSV e apagar.

## Parte 3 - Login Google

No Supabase:
- `Authentication > Providers > Google` (habilitar)

No Google Cloud OAuth:
- Adicionar redirect URI do Supabase.

No Supabase URL Configuration:
- Garantir redirect do app desktop:
  - `https://medcore.local/auth/callback`

## Parte 4 - Teste rapido

1. PC A: logar com Google e entrar no codigo da clinica.
2. Cadastrar 1 paciente.
3. PC B: mesmo codigo da clinica.
4. Verificar se aparece em poucos segundos.
5. Excluir paciente no PC A.
6. Confirmar remocao no PC B.

Se isso funcionar, a migracao esta OK.

## Observacoes importantes

1. `anon/public key` pode ficar no app.
2. Nunca usar `service_role` dentro do app desktop.
3. Se aparecer erro de tabela/funcao ausente:
- rode novamente `supabase/setup.sql`.

## Update 2026
- O setup.sql agora ja cria grants explicitos no schema public para evitar erro 42501 nas mudancas de Data API do Supabase.
- O setup.sql tambem configura default privileges para novas tabelas/funcoes/sequences no schema public.
- O setup.sql inclui bloco opcional (comentado) para role `supabase_admin`, caso seu ambiente use esse owner para criar objetos.
- No painel do Supabase, habilite leaked password protection em Auth para reforcar seguranca de contas.

