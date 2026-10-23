-- Run as the project database operator after the marketplace migration.
-- Same named job is updated rather than duplicated when rerun by the same owner.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('two-hands-settlement','* * * * *','select public.th_settle();');

-- Review the job and recent executions from the Supabase Cron dashboard.
select jobname,schedule,active from cron.job where jobname='two-hands-settlement';
