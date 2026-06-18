-- MedCore - RESET COMPLETO DOS DADOS DE WORKSPACE
-- Use somente se quiser reiniciar do zero o banco do MedCore.
-- Nao apaga usuarios do Supabase Auth, apenas dados do app.

begin;

truncate table public.workspace_logins restart identity;
truncate table public.workspace_members;
truncate table public.workspace_registry;

truncate table public.workspace_config_rows;
truncate table public.workspace_usuarios_rows;
truncate table public.workspace_medicos_rows;
truncate table public.workspace_pacientes_rows;
truncate table public.workspace_agenda_rows;
truncate table public.workspace_prontuarios_rows;
truncate table public.workspace_asos_rows;
truncate table public.workspace_financeiro_rows;
truncate table public.workspace_estoque_rows;
truncate table public.workspace_medicamentos_rows;
truncate table public.workspace_exames_banco_rows;
truncate table public.workspace_solicitacoes_exames_rows;
truncate table public.workspace_receituarios_salvos_rows;
truncate table public.workspace_locais_rows;

-- Legado (mantido apenas para compatibilidade/migracao)
truncate table public.workspace_rows;
truncate table public.workspace_snapshots;

commit;
