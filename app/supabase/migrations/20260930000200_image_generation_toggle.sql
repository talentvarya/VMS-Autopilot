-- Phase G.8b - a real, admin-controlled ON/OFF switch for image generation, separate from the
-- code-level LIVE_IMAGE_GEN_ENABLED gate. Defaults OFF: even though the OpenAI key and the
-- code both already exist, nothing calls the real provider and nothing can cost money until
-- the Admin explicitly turns this on for their own agency, whenever they are ready to pay.

alter table public.workspace_settings
  add column image_generation_enabled boolean not null default false;

grant update (image_generation_enabled) on public.workspace_settings to authenticated;
